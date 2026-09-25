Option Explicit

Const API_URL = "http://127.0.0.1:4174/api/health"
Const DEFAULT_URL = "http://127.0.0.1:4174/"
Const FOR_APPENDING = 8
Const ASCII_TEXT = 0

Dim shell, fso, projectDirectory, attempt, siteUrl
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectDirectory

' Build the static page on first use when dependencies are already installed.
If Not fso.FileExists(fso.BuildPath(projectDirectory, "dist\index.html")) Then
  Dim buildExitCode
  buildExitCode = shell.Run("cmd.exe /d /s /c npm run build", 0, True)
  If buildExitCode <> 0 Or Not fso.FileExists(fso.BuildPath(projectDirectory, "dist\index.html")) Then
    WriteLauncherFailure "Frontend build failed"
    MsgBox "BiliScribe 页面准备失败。请确认 Node.js 和项目依赖已安装。", vbExclamation, "BiliScribe"
    WScript.Quit 1
  End If
End If

siteUrl = GetReadyProductionUrl()
If siteUrl <> "" Then
  OpenBrowser siteUrl
  WScript.Quit 0
End If

' npm starts the production server; the window is hidden and runs independently.
shell.Run "cmd.exe /d /s /c npm run start", 0, False

' Poll the health endpoint so the browser only opens after the service is ready.
For attempt = 1 To 40
  siteUrl = GetReadyProductionUrl()
  If siteUrl <> "" Then
    OpenBrowser siteUrl
    WScript.Quit 0
  End If
  WScript.Sleep 500
Next

WriteLauncherFailure "Service did not become ready within 20 seconds"
MsgBox "BiliScribe 启动失败。请确认 Node.js 和项目文件完整后重试。", vbExclamation, "BiliScribe"
WScript.Quit 1

Function GetReadyProductionUrl()
  On Error Resume Next
  Dim request, body, marker, startAt, endAt
  GetReadyProductionUrl = ""
  Set request = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  request.setTimeouts 500, 500, 700, 700
  request.Open "GET", API_URL, False
  request.Send
  If Err.Number = 0 And request.Status = 200 Then
    body = request.responseText
    If InStr(1, body, Chr(34) & "mode" & Chr(34) & ":" & Chr(34) & "production" & Chr(34), vbTextCompare) > 0 Or InStr(1, body, Chr(34) & "mode" & Chr(34) & ":" & Chr(34) & "development" & Chr(34), vbTextCompare) > 0 Then
      marker = Chr(34) & "webUrl" & Chr(34) & ":" & Chr(34)
      startAt = InStr(1, body, marker, vbTextCompare)
      If startAt > 0 Then
        startAt = startAt + Len(marker)
        endAt = InStr(startAt, body, Chr(34))
        If endAt > startAt Then GetReadyProductionUrl = Mid(body, startAt, endAt - startAt)
      End If
      If GetReadyProductionUrl = "" Then GetReadyProductionUrl = DEFAULT_URL
    End If
  End If
  Err.Clear
  On Error GoTo 0
End Function

Sub OpenBrowser(address)
  On Error Resume Next
  shell.Run address, 1, False
  On Error GoTo 0
End Sub

Sub WriteLauncherFailure(reason)
  On Error Resume Next
  Dim logDirectory, logFile, stream, stamp, line
  logDirectory = fso.BuildPath(projectDirectory, "logs")
  If Not fso.FolderExists(logDirectory) Then fso.CreateFolder logDirectory
  logFile = fso.BuildPath(logDirectory, "biliscribe.log")
  stamp = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & "T" & Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)
  line = "{" & Chr(34) & "time" & Chr(34) & ":" & Chr(34) & stamp & Chr(34) & "," & Chr(34) & "level" & Chr(34) & ":" & Chr(34) & "error" & Chr(34) & "," & Chr(34) & "event" & Chr(34) & ":" & Chr(34) & "Windows launcher failed" & Chr(34) & "," & Chr(34) & "message" & Chr(34) & ":" & Chr(34) & reason & Chr(34) & "}"
  Set stream = fso.OpenTextFile(logFile, FOR_APPENDING, True, ASCII_TEXT)
  stream.WriteLine line
  stream.Close
  On Error GoTo 0
End Sub
