const MAX_INPUT_BYTES = 524_288;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_STRING_BYTES = 16_384;
const MAX_TOTAL_BYTES = 262_144;
const MAX_CONTAINER_ENTRIES = 1_000;

/** Parses untrusted JSON while enforcing limits before building each container. */
export function parseBoundedPolicyJson(input: unknown): unknown | undefined {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) return undefined;
  const json = input;
  let offset = 0;
  let nodes = 0;
  let totalStringBytes = 0;
  const fail = (): never => { throw new TypeError("Policy JSON is invalid or exceeds resource limits."); };
  const accountString = (value: string): void => {
    const bytes = Buffer.byteLength(value, "utf8");
    totalStringBytes += bytes;
    if (bytes > MAX_STRING_BYTES || totalStringBytes > MAX_TOTAL_BYTES) fail();
  };
  const whitespace = (): void => {
    while (offset < json.length &&
      (json[offset] === " " || json[offset] === "\n" || json[offset] === "\r" || json[offset] === "\t")) offset += 1;
  };
  const parseString = (): string => {
    if (json[offset] !== '"') fail();
    const start = offset++;
    while (offset < json.length) {
      const char = json[offset];
      if (char === '"') {
        offset += 1;
        const value: unknown = JSON.parse(json.slice(start, offset));
        if (typeof value !== "string") fail();
        accountString(value);
        return value;
      }
      offset += char === "\\" ? 2 : 1;
    }
    return fail();
  };
  const parseValue = (depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail();
    whitespace();
    const char = json[offset];
    if (char === '"') return parseString();
    if (char === "{") {
      offset += 1;
      whitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      let entries = 0;
      if (json[offset] === "}") { offset += 1; return Object.freeze(result); }
      while (true) {
        whitespace();
        const key = parseString();
        entries += 1;
        if (entries > MAX_CONTAINER_ENTRIES || seen.has(key)) fail();
        seen.add(key);
        whitespace();
        if (json[offset] !== ":") fail();
        offset += 1;
        const value = parseValue(depth + 1);
        Object.defineProperty(result, key, { value, enumerable: true, configurable: false, writable: false });
        whitespace();
        if (json[offset] === "}") { offset += 1; return Object.freeze(result); }
        if (json[offset] !== ",") fail();
        offset += 1;
      }
    }
    if (char === "[") {
      offset += 1;
      whitespace();
      const result: unknown[] = [];
      if (json[offset] === "]") { offset += 1; return Object.freeze(result); }
      while (true) {
        if (result.length >= MAX_CONTAINER_ENTRIES) fail();
        accountString(String(result.length));
        result.push(parseValue(depth + 1));
        whitespace();
        if (json[offset] === "]") { offset += 1; return Object.freeze(result); }
        if (json[offset] !== ",") fail();
        offset += 1;
      }
    }
    if (char === "t" && json.slice(offset, offset + 4) === "true") { offset += 4; return true; }
    if (char === "f" && json.slice(offset, offset + 5) === "false") { offset += 5; return false; }
    if (char === "n" && json.slice(offset, offset + 4) === "null") { offset += 4; return null; }
    const start = offset;
    while (offset < json.length && /[0-9eE+.-]/.test(json[offset] ?? "")) offset += 1;
    if (start === offset) return fail();
    const token = json.slice(start, offset);
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) fail();
    const number = Number(token);
    if (!Number.isFinite(number)) fail();
    return number;
  };
  try {
    whitespace();
    const value = parseValue(0);
    whitespace();
    return offset === json.length ? value : undefined;
  } catch {
    return undefined;
  }
}
