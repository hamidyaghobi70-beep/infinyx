#![cfg(target_os = "linux")]

//! Versioned, bounded transport primitives for the INFINYX Linux broker.
//!
//! This crate deliberately does not launch processes or mutate cgroups. It is
//! the protocol foundation only; a daemon must add peer authorization,
//! durable ownership/recovery, and verified cgroup lifecycle before use.

pub mod preflight;

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCredentials {
    pub pid: i32,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u16,
    pub request_id: String,
    pub operation: Operation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum Operation {
    LaunchTrustedRunner,
    RunnerSend {
        containment_id: String,
        payload: serde_json::Value,
    },
    TerminateBoundary {
        containment_id: String,
    },
    WaitBoundaryEmpty {
        containment_id: String,
        timeout_ms: u32,
    },
    ReleaseBoundary {
        containment_id: String,
    },
    QueryStatus {
        containment_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub version: u16,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

impl Request {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ProtocolError::new(
                "unsupported_version",
                "The requested broker protocol version is not supported.",
            ));
        }
        if !valid_identifier(&self.request_id) {
            return Err(ProtocolError::new(
                "invalid_request_id",
                "The request identifier is malformed.",
            ));
        }
        match &self.operation {
            Operation::RunnerSend { containment_id, .. }
            | Operation::TerminateBoundary { containment_id }
            | Operation::WaitBoundaryEmpty { containment_id, .. }
            | Operation::ReleaseBoundary { containment_id }
            | Operation::QueryStatus { containment_id } => {
                if !valid_identifier(containment_id) {
                    return Err(ProtocolError::new(
                        "invalid_containment_id",
                        "The containment identifier is malformed.",
                    ));
                }
            }
            Operation::LaunchTrustedRunner => {}
        }
        if let Operation::WaitBoundaryEmpty { timeout_ms, .. } = &self.operation {
            if *timeout_ms == 0 || *timeout_ms > 120_000 {
                return Err(ProtocolError::new(
                    "invalid_timeout",
                    "The wait timeout must be between 1 and 120000 milliseconds.",
                ));
            }
        }
        Ok(())
    }
}

/// Decode and validate one complete request payload.
pub fn decode_request(payload: &[u8]) -> Result<Request, ProtocolError> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            "invalid_frame_length",
            "The request frame length is outside the allowed range.",
        ));
    }
    let request: Request = serde_json::from_slice(payload).map_err(|_| {
        ProtocolError::new("invalid_json", "The request payload is not valid protocol JSON.")
    })?;
    request.validate()?;
    Ok(request)
}

/// Authorize the kernel-reported peer UID against one administrator-configured UID.
/// This function does not read identity claims from the wire protocol.
pub fn authorize_peer(peer: PeerCredentials, allowed_uid: u32) -> Result<(), ProtocolError> {
    if peer.pid <= 0 || peer.uid != allowed_uid {
        return Err(ProtocolError::new(
            "peer_not_authorized",
            "The connected Unix socket peer is not authorized.",
        ));
    }
    Ok(())
}

impl ProtocolError {
    pub fn new(code: &str, message: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// Read one 4-byte big-endian length-prefixed JSON frame.
/// The limit is checked before allocating the payload buffer.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame length"));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(payload)
}

/// Write one bounded 4-byte big-endian length-prefixed JSON frame.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid frame length"));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Obtain kernel-authenticated Unix socket peer credentials on Linux.
/// Never accept a PID/UID/GID supplied in a protocol request as identity.
#[cfg(target_os = "linux")]
pub fn peer_credentials<S: AsRawFd>(stream: &S) -> io::Result<PeerCredentials> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt writes exactly the ucred structure when the returned
    // length matches its size. The descriptor is borrowed from the live stream.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected peer credential size"));
    }
    // SAFETY: successful getsockopt above initialized a full ucred value.
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid peer process id"));
    }
    Ok(PeerCredentials {
        pid: credentials.pid,
        uid: credentials.uid,
        gid: credentials.gid,
    })
}


fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_round_trip() {
        let payload = br#"{"version":1,"request_id":"req-1"}"#;
        let mut encoded = Vec::new();
        write_frame(&mut encoded, payload).unwrap();
        assert_eq!(read_frame(&mut Cursor::new(encoded)).unwrap(), payload);
    }

    #[test]
    fn rejects_zero_and_oversized_frames_before_payload_read() {
        assert!(read_frame(&mut Cursor::new(0_u32.to_be_bytes())).is_err());
        assert!(read_frame(&mut Cursor::new(((MAX_FRAME_BYTES + 1) as u32).to_be_bytes())).is_err());
    }

    #[test]
    fn rejects_truncated_frame_header() {
        let error = read_frame(&mut Cursor::new([0_u8, 0_u8, 0_u8])).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn rejects_truncated_frame_payload_without_returning_partial_data() {
        let mut frame = Vec::from(5_u32.to_be_bytes());
        frame.extend_from_slice(b"ab");
        let error = read_frame(&mut Cursor::new(frame)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn rejects_empty_overlong_and_non_ascii_identifiers() {
        let base = Request {
            version: PROTOCOL_VERSION,
            request_id: "req-1".into(),
            operation: Operation::LaunchTrustedRunner,
        };

        let mut bad = base.clone();
        bad.request_id.clear();
        assert_eq!(bad.validate().unwrap_err().code, "invalid_request_id");

        let mut bad = base.clone();
        bad.request_id = "x".repeat(MAX_ID_BYTES + 1);
        assert_eq!(bad.validate().unwrap_err().code, "invalid_request_id");

        let mut bad = base;
        bad.request_id = "req-💡".into();
        assert_eq!(bad.validate().unwrap_err().code, "invalid_request_id");
    }

    #[test]
    fn rejects_oversized_outbound_frame() {
        let payload = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(write_frame(&mut Vec::new(), &payload).is_err());
    }

    #[test]
    fn validates_version_ids_and_bounded_wait() {
        let good = Request {
            version: PROTOCOL_VERSION,
            request_id: "req-01".into(),
            operation: Operation::WaitBoundaryEmpty {
                containment_id: "exec-01".into(),
                timeout_ms: 5_000,
            },
        };
        assert!(good.validate().is_ok());

        let mut bad = good.clone();
        bad.version = 2;
        assert_eq!(bad.validate().unwrap_err().code, "unsupported_version");

        let mut bad = good.clone();
        bad.request_id = "../escape".into();
        assert_eq!(bad.validate().unwrap_err().code, "invalid_request_id");

        let mut bad = good;
        bad.operation = Operation::WaitBoundaryEmpty {
            containment_id: "exec-01".into(),
            timeout_ms: 0,
        };
        assert_eq!(bad.validate().unwrap_err().code, "invalid_timeout");
    }

    #[test]
    fn decoder_rejects_unknown_fields_and_malformed_json() {
        let unknown = br#"{"version":1,"request_id":"r1","operation":{"op":"LAUNCH_TRUSTED_RUNNER"},"uid":0}"#;
        assert_eq!(decode_request(unknown).unwrap_err().code, "invalid_json");
        assert_eq!(decode_request(b"{").unwrap_err().code, "invalid_json");
        assert_eq!(decode_request(&[]).unwrap_err().code, "invalid_frame_length");
    }

    #[test]
    fn peer_authorization_uses_kernel_uid_value() {
        let peer = PeerCredentials { pid: 123, uid: 1001, gid: 1001 };
        assert!(authorize_peer(peer, 1001).is_ok());
        assert_eq!(authorize_peer(peer, 1002).unwrap_err().code, "peer_not_authorized");
        assert_eq!(
            authorize_peer(PeerCredentials { pid: -1, uid: 1001, gid: 1001 }, 1001)
                .unwrap_err().code,
            "peer_not_authorized"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_peer_credentials_from_local_unix_socket() {
        use std::os::unix::net::UnixStream;
        let (left, _right) = UnixStream::pair().unwrap();
        let peer = peer_credentials(&left).unwrap();
        assert!(peer.pid > 0);
        assert_eq!(peer.uid, unsafe { libc::geteuid() });
    }

    #[test]
    fn operation_does_not_accept_caller_selected_executable() {
        let request = Request {
            version: 1,
            request_id: "req-2".into(),
            operation: Operation::LaunchTrustedRunner,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(!json.contains("executable"));
        assert!(!json.contains("runner_path"));
    }
}
