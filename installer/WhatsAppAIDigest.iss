; Windows installer for WhatsApp AI Digest (Inno Setup 6).
; Built by .github/workflows/installer.yml from a staged "payload" folder:
;   payload\WhatsAppAIDigestTray.exe   tray app (starts/stops the server)
;   payload\node\node.exe              bundled Node.js — nothing else to install
;   payload\server\server.mjs          the server bundled into one file (apps/server: pnpm bundle)
;   payload\server\.env.example
;   payload\extension\                 the built Chrome extension (load unpacked)
; Settings (Groq key) live in %LOCALAPPDATA%\WhatsAppAIDigest\.env, outside the program folder, so they survive updates.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#define AppName "WhatsApp AI Digest"
#define TrayExe "WhatsAppAIDigestTray.exe"

[Setup]
AppId={{7A78FDC7-487C-4FE6-B15A-310E6E5E8226}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=romanro
AppPublisherURL=https://github.com/romanro/whatsapp-ai-digest
DefaultDirName={localappdata}\Programs\WhatsAppAIDigest
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=WhatsAppAIDigestSetup
SetupIconFile=..\apps\tray-windows\icons\app.ico
UninstallDisplayIcon={app}\{#TrayExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "autostart"; Description: "Запускать при входе в Windows"
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; Flags: unchecked

[InstallDelete]
; Remove files of the previous version (the extension and server are replaced as a whole).
Type: filesandordirs; Name: "{app}\extension"
Type: filesandordirs; Name: "{app}\server"

[Files]
Source: "payload\{#TrayExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "payload\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "payload\server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs
Source: "payload\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#TrayExe}"
Name: "{autoprograms}\{#AppName} — папка расширения"; Filename: "{app}\extension"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#TrayExe}"; Tasks: desktopicon

[Registry]
; Same value the tray app's "Запускать при входе в Windows" menu item uses.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "WhatsAppAIDigest"; \
  ValueData: """{app}\{#TrayExe}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#TrayExe}"; Description: "Запустить {#AppName}"; Flags: postinstall nowait skipifsilent
Filename: "{code:ChromePath}"; Parameters: "chrome://extensions"; Description: "Открыть страницу расширений Chrome"; \
  Flags: postinstall nowait skipifsilent; Check: ChromeFound
Filename: "{win}\explorer.exe"; Parameters: """{app}\extension"""; Description: "Открыть папку расширения"; \
  Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#TrayExe}"; Flags: runhidden; RunOnceId: "StopTray"

[Code]
var
  KeyPage: TInputQueryWizardPage;

function DataDir: String;
begin
  Result := ExpandConstant('{localappdata}\WhatsAppAIDigest');
end;

function EnvPath: String;
begin
  Result := DataDir + '\.env';
end;

{ Value of GROQ_API_KEY in the existing settings, or ''. }
function ExistingKey: String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(EnvPath, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos('GROQ_API_KEY=', Trim(Lines[I])) = 1 then
        Result := Trim(Copy(Trim(Lines[I]), Length('GROQ_API_KEY=') + 1, MaxInt));
end;

function ChromePath(Param: String): String;
begin
  Result := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  if FileExists(Result) then Exit;
  Result := ExpandConstant('{commonpf64}\Google\Chrome\Application\chrome.exe');
  if FileExists(Result) then Exit;
  Result := ExpandConstant('{commonpf32}\Google\Chrome\Application\chrome.exe');
  if FileExists(Result) then Exit;
  Result := '';
end;

function ChromeFound: Boolean;
begin
  Result := ChromePath('') <> '';
end;

procedure InitializeWizard;
begin
  KeyPage := CreateInputQueryPage(wpSelectTasks,
    'Ключ Groq',
    'Сводки готовит облачный сервис Groq. Для него нужен бесплатный ключ.',
    'Создайте ключ на https://console.groq.com/keys (кнопка «Create API Key»), скопируйте его и вставьте ниже.' + #13#10 +
    'Ключ хранится только на этом компьютере. Его можно добавить или поменять позже: меню значка в трее → «Настройки сервера (.env)».');
  KeyPage.Add('Ключ (начинается с gsk_):', False);
  KeyPage.Values[0] := ExistingKey;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Key: String;
begin
  Result := True;
  if CurPageID <> KeyPage.ID then Exit;
  Key := Trim(KeyPage.Values[0]);
  KeyPage.Values[0] := Key;
  if Key = '' then
    Result := MsgBox('Без ключа сводки работать не будут. Продолжить без ключа и добавить его позже?',
      mbConfirmation, MB_YESNO) = IDYES
  else if Pos('gsk_', Key) <> 1 then
    Result := MsgBox('Ключи Groq обычно начинаются с «gsk_». Всё равно использовать этот ключ?',
      mbConfirmation, MB_YESNO) = IDYES;
end;

{ Writes the key into %LOCALAPPDATA%\WhatsAppAIDigest\.env, creating it from .env.example; other settings are kept. }
procedure SaveKey(Key: String);
var
  Lines: TArrayOfString;
  I: Integer;
  Found: Boolean;
begin
  ForceDirectories(DataDir);
  if not LoadStringsFromFile(EnvPath, Lines) then
    if not LoadStringsFromFile(ExpandConstant('{app}\server\.env.example'), Lines) then
      SetArrayLength(Lines, 0);
  Found := False;
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Pos('GROQ_API_KEY=', Trim(Lines[I])) = 1 then
    begin
      Lines[I] := 'GROQ_API_KEY=' + Key;
      Found := True;
    end;
  if not Found then
  begin
    SetArrayLength(Lines, GetArrayLength(Lines) + 1);
    Lines[GetArrayLength(Lines) - 1] := 'GROQ_API_KEY=' + Key;
  end;
  SaveStringsToUTF8FileWithoutBOM(EnvPath, Lines, False);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  { Stop a running tray app (and with it the server) so its files can be replaced. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM {#TrayExe}', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Key: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if WizardSilent then
    Key := Trim(ExpandConstant('{param:GROQKEY|}'))
  else
    Key := Trim(KeyPage.Values[0]);
  if (Key <> '') or not FileExists(EnvPath) then
    SaveKey(Key);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption :=
      'Осталось один раз подключить расширение в Chrome:' + #13#10 + #13#10 +
      '1. Откройте chrome://extensions и включите «Режим разработчика» (справа сверху).' + #13#10 +
      '2. Нажмите «Загрузить распакованное расширение» и выберите папку:' + #13#10 +
      '    ' + ExpandConstant('{app}\extension') + #13#10 +
      '3. Закрепите значок расширения через кнопку с пазлом.' + #13#10 + #13#10 +
      'Отмеченные ниже пункты откроют страницу расширений и эту папку.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    { The tray app can enable autostart by itself — remove it in any case. }
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'WhatsAppAIDigest');
  if (CurUninstallStep = usPostUninstall) and DirExists(DataDir) then
    { Silent uninstalls keep the settings. }
    if not UninstallSilent and
       (MsgBox('Удалить и настройки (ключ Groq) и журнал сервера?' + #13#10 + DataDir, mbConfirmation, MB_YESNO) = IDYES) then
      DelTree(DataDir, True, True, True);
end;
