#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <io.h>
#include <stdint.h>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST 0x0002000D
#endif

static void fail(const wchar_t *message, DWORD error) {
  fwprintf(stderr, L"job-launcher-poc: %ls (win32=%lu)\n", message, (unsigned long)error);
}

static BOOL valid_handle(HANDLE handle) {
  return handle != NULL && handle != INVALID_HANDLE_VALUE;
}

static BOOL append_unique(HANDLE *handles, DWORD *count, HANDLE value) {
  if (!valid_handle(value)) return TRUE;
  for (DWORD i = 0; i < *count; ++i) {
    if (handles[i] == value) return TRUE;
  }
  handles[(*count)++] = value;
  return TRUE;
}

static wchar_t *quote_arg(const wchar_t *arg) {
  size_t length = wcslen(arg);
  size_t capacity = length * 2 + 3;
  wchar_t *quoted = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, capacity * sizeof(wchar_t));
  if (!quoted) return NULL;

  size_t out = 0;
  quoted[out++] = L'"';
  size_t slashes = 0;
  for (size_t i = 0; i < length; ++i) {
    wchar_t ch = arg[i];
    if (ch == L'\\') {
      ++slashes;
      continue;
    }
    if (ch == L'"') {
      for (size_t j = 0; j < slashes * 2 + 1; ++j) quoted[out++] = L'\\';
      quoted[out++] = L'"';
      slashes = 0;
      continue;
    }
    for (size_t j = 0; j < slashes; ++j) quoted[out++] = L'\\';
    slashes = 0;
    quoted[out++] = ch;
  }
  for (size_t j = 0; j < slashes * 2; ++j) quoted[out++] = L'\\';
  quoted[out++] = L'"';
  quoted[out] = L'\0';
  return quoted;
}

static BOOL wait_for_empty_job(HANDLE job) {
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
        &accounting, sizeof(accounting), NULL)) {
      fail(L"could not query Job Object accounting", GetLastError());
      return FALSE;
    }
    if (accounting.ActiveProcesses == 0) return TRUE;
    Sleep(10);
  }
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 3) {
    fwprintf(stderr, L"usage: job-launcher-poc.exe <node.exe> <ipc-child.mjs>\n");
    return 64;
  }

  const wchar_t *ipcFdText = _wgetenv(L"NODE_CHANNEL_FD");
  if (!ipcFdText || !*ipcFdText) {
    fail(L"NODE_CHANNEL_FD is missing; refusing to launch", ERROR_INVALID_PARAMETER);
    return 65;
  }
  wchar_t *end = NULL;
  long ipcFd = wcstol(ipcFdText, &end, 10);
  if (!end || *end != L'\0' || ipcFd < 0 || ipcFd > 1024) {
    fail(L"NODE_CHANNEL_FD is invalid", ERROR_INVALID_PARAMETER);
    return 65;
  }

  intptr_t ipcRaw = _get_osfhandle((int)ipcFd);
  if (ipcRaw == -1 || !valid_handle((HANDLE)ipcRaw)) {
    fail(L"the Node IPC descriptor is not available as a Windows handle", ERROR_INVALID_HANDLE);
    return 66;
  }
  HANDLE ipcHandle = (HANDLE)ipcRaw;

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!valid_handle(job)) {
    fail(L"CreateJobObjectW failed", GetLastError());
    return 70;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
      &limits, sizeof(limits))) {
    DWORD error = GetLastError();
    CloseHandle(job);
    fail(L"could not enable KILL_ON_JOB_CLOSE", error);
    return 71;
  }

  HANDLE inherited[4];
  DWORD inheritedCount = 0;
  HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE stdoutHandle = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE stderrHandle = GetStdHandle(STD_ERROR_HANDLE);
  append_unique(inherited, &inheritedCount, stdinHandle);
  append_unique(inherited, &inheritedCount, stdoutHandle);
  append_unique(inherited, &inheritedCount, stderrHandle);
  append_unique(inherited, &inheritedCount, ipcHandle);

  for (DWORD i = 0; i < inheritedCount; ++i) {
    if (!SetHandleInformation(inherited[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
      DWORD error = GetLastError();
      CloseHandle(job);
      fail(L"could not mark an explicitly allowed child handle inheritable", error);
      return 72;
    }
  }

  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &attributeBytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes =
    (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attributeBytes);
  if (!attributes || !InitializeProcThreadAttributeList(attributes, 2, 0, &attributeBytes)) {
    DWORD error = GetLastError();
    if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job);
    fail(L"could not initialize process attribute list", error);
    return 73;
  }

  HANDLE jobs[1] = { job };
  BOOL attributesOk =
    UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
      jobs, sizeof(jobs), NULL, NULL) &&
    UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited, inheritedCount * sizeof(HANDLE), NULL, NULL);
  if (!attributesOk) {
    DWORD error = GetLastError();
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job);
    fail(L"could not configure Job/handle inheritance attributes", error);
    return 74;
  }

  wchar_t *nodeArg = quote_arg(argv[1]);
  wchar_t *scriptArg = quote_arg(argv[2]);
  if (!nodeArg || !scriptArg) {
    if (nodeArg) HeapFree(GetProcessHeap(), 0, nodeArg);
    if (scriptArg) HeapFree(GetProcessHeap(), 0, scriptArg);
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job);
    fail(L"could not allocate command line", ERROR_OUTOFMEMORY);
    return 75;
  }

  size_t commandCapacity = wcslen(nodeArg) + wcslen(scriptArg) + 2;
  wchar_t *commandLine = (wchar_t *)HeapAlloc(GetProcessHeap(), 0,
    commandCapacity * sizeof(wchar_t));
  if (!commandLine) {
    HeapFree(GetProcessHeap(), 0, nodeArg);
    HeapFree(GetProcessHeap(), 0, scriptArg);
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job);
    fail(L"could not allocate command line buffer", ERROR_OUTOFMEMORY);
    return 75;
  }
  swprintf_s(commandLine, commandCapacity, L"%ls %ls", nodeArg, scriptArg);
  HeapFree(GetProcessHeap(), 0, nodeArg);
  HeapFree(GetProcessHeap(), 0, scriptArg);

  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdinHandle;
  startup.StartupInfo.hStdOutput = stdoutHandle;
  startup.StartupInfo.hStdError = stderrHandle;
  startup.lpAttributeList = attributes;

  PROCESS_INFORMATION processInfo;
  ZeroMemory(&processInfo, sizeof(processInfo));
  DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
  BOOL created = CreateProcessW(argv[1], commandLine, NULL, NULL, TRUE, flags,
    NULL, NULL, &startup.StartupInfo, &processInfo);
  DWORD createError = created ? ERROR_SUCCESS : GetLastError();

  HeapFree(GetProcessHeap(), 0, commandLine);
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);

  for (DWORD i = 0; i < inheritedCount; ++i) {
    SetHandleInformation(inherited[i], HANDLE_FLAG_INHERIT, 0);
  }

  if (!created) {
    CloseHandle(job);
    fail(L"CreateProcessW with creation-time Job association failed", createError);
    return 76;
  }

  DWORD resumeResult = ResumeThread(processInfo.hThread);
  if (resumeResult == (DWORD)-1) {
    DWORD error = GetLastError();
    TerminateJobObject(job, 77);
    WaitForSingleObject(processInfo.hProcess, INFINITE);
    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);
    CloseHandle(job);
    fail(L"ResumeThread failed; Job terminated", error);
    return 77;
  }

  WaitForSingleObject(processInfo.hProcess, INFINITE);
  DWORD childExit = 0;
  GetExitCodeProcess(processInfo.hProcess, &childExit);
  BOOL empty = wait_for_empty_job(job);

  CloseHandle(processInfo.hThread);
  CloseHandle(processInfo.hProcess);
  CloseHandle(job);
  if (!empty) return 78;
  return (int)childExit;
}
