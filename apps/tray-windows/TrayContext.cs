using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WadTray
{
    /// <summary>Tray icon + menu. Starts the server on launch, shows its status, stops it on exit.</summary>
    internal sealed class TrayContext : ApplicationContext
    {
        private enum ServerState { NotSetUp, Stopped, Starting, Running, External, PortBusy, Error }

        private const string AppName = "WhatsApp AI Digest";
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValue = "WhatsAppAIDigest";

        private readonly Control _ui = new Control();
        private readonly ServerProcess _server = new ServerProcess();
        private readonly NotifyIcon _tray;
        private readonly Timer _timer;
        private readonly Icon _iconOk, _iconStopped, _iconWarn;

        private readonly ToolStripMenuItem _miStatus, _miAi, _miStart, _miStop, _miRestart, _miAutostart, _miEnv, _miLog, _miFolder;

        private string _repo, _node, _setupProblem, _lastError;
        private int _port = 3001;
        private ServerState _state = ServerState.Stopped;
        private HealthInfo _health = new HealthInfo();
        private DateTime _startedAt;
        private bool _polling, _aiWarned;

        public TrayContext()
        {
            _ui.CreateControl(); // for marshalling events from background threads to the UI thread

            _iconOk = LoadIcon("app.ico");
            _iconStopped = LoadIcon("stopped.ico");
            _iconWarn = LoadIcon("warning.ico");

            _miStatus = new ToolStripMenuItem { Enabled = false, Font = new Font(SystemFonts.MenuFont, FontStyle.Bold) };
            _miAi = new ToolStripMenuItem { Enabled = false };
            _miStart = new ToolStripMenuItem("Запустить сервер", null, (s, e) => StartServer(true));
            _miStop = new ToolStripMenuItem("Остановить сервер", null, (s, e) => StopServer());
            _miRestart = new ToolStripMenuItem("Перезапустить сервер", null, (s, e) => { StopServer(); StartServer(true); });
            _miEnv = new ToolStripMenuItem("Настройки сервера (.env)…", null, (s, e) => OpenEnv());
            _miLog = new ToolStripMenuItem("Открыть журнал сервера", null, (s, e) => OpenLog());
            _miFolder = new ToolStripMenuItem("Указать папку проекта…", null, (s, e) => { ChooseRepo(); Setup(); StartServer(true); });
            _miAutostart = new ToolStripMenuItem("Запускать при входе в Windows") { CheckOnClick = true, Checked = IsAutostart() };
            _miAutostart.CheckedChanged += (s, e) => SetAutostart(_miAutostart.Checked);

            var menu = new ContextMenuStrip();
            menu.Items.AddRange(new ToolStripItem[]
            {
                _miStatus, _miAi,
                new ToolStripSeparator(),
                new ToolStripMenuItem("Открыть WhatsApp Web", null, (s, e) => Open("https://web.whatsapp.com/")),
                new ToolStripSeparator(),
                _miStart, _miStop, _miRestart,
                new ToolStripSeparator(),
                _miEnv, _miLog, _miFolder, _miAutostart,
                new ToolStripSeparator(),
                new ToolStripMenuItem("Выход", null, (s, e) => ExitApp()),
            });
            menu.Opening += (s, e) => UpdateUi();

            _tray = new NotifyIcon { Icon = _iconStopped, Text = AppName, ContextMenuStrip = menu, Visible = true };
            _tray.DoubleClick += (s, e) => Open("https://web.whatsapp.com/");

            _server.Exited += (s, e) => _ui.BeginInvoke(new Action(() => OnServerExited(e)));
            Application.ApplicationExit += (s, e) => _server.Dispose();
            SystemEvents.SessionEnding += (s, e) => _server.Dispose();

            _timer = new Timer { Interval = 4000 };
            _timer.Tick += async (s, e) => await PollAsync();
            _timer.Start();

            Setup();
            if (_repo == null && _setupProblem != null && Paths.FindRepoRoot() == null)
            {
                ChooseRepo();
                Setup();
            }
            UpdateUi();
            _ui.BeginInvoke(new Action(async () =>
            {
                await PollAsync();
                if (_state == ServerState.Stopped) StartServer(false);
            }));
        }

        /* ---------------- setup ---------------- */

        private void Setup()
        {
            _setupProblem = null;
            _repo = Paths.FindRepoRoot();
            if (_repo == null)
            {
                _setupProblem = "Не найдена папка проекта. Меню → «Указать папку проекта…».";
            }
            else
            {
                _port = Paths.ReadPort(_repo);
                _node = Paths.FindNode();
                if (_node == null)
                    _setupProblem = "Не найден Node.js. Установите Node.js 22+ (nodejs.org) и перезапустите приложение.";
                else if (!Directory.Exists(Path.Combine(Paths.ServerDir(_repo), "node_modules", "tsx")))
                    _setupProblem = "Зависимости не установлены. Выполните «pnpm install» в папке проекта.";
            }
            _state = _setupProblem != null ? ServerState.NotSetUp : ServerState.Stopped;
        }

        private void ChooseRepo()
        {
            using (var dlg = new FolderBrowserDialog
            {
                Description = "Выберите папку проекта whatsapp-ai-digest (в ней есть pnpm-workspace.yaml)",
                ShowNewFolderButton = false,
            })
            {
                if (dlg.ShowDialog() != DialogResult.OK) return;
                if (Paths.IsRepo(dlg.SelectedPath))
                    Paths.SaveRepoRoot(dlg.SelectedPath);
                else
                    MessageBox.Show("Это не папка проекта whatsapp-ai-digest.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /* ---------------- server control ---------------- */

        private void StartServer(bool userInitiated)
        {
            if (_state == ServerState.NotSetUp)
            {
                Setup();
                if (_state == ServerState.NotSetUp)
                {
                    if (userInitiated) Balloon(_setupProblem, ToolTipIcon.Warning);
                    UpdateUi();
                    return;
                }
            }
            if (_server.IsRunning || _state == ServerState.External) return;
            _port = Paths.ReadPort(_repo);
            _lastError = null;
            _aiWarned = false;
            try
            {
                _server.Start(_node, Paths.ServerDir(_repo));
                _startedAt = DateTime.Now;
                _state = ServerState.Starting;
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is IOException || ex is InvalidOperationException)
            {
                _state = ServerState.Error;
                _lastError = "Не удалось запустить Node.js: " + ex.Message;
                Balloon(_lastError, ToolTipIcon.Error);
            }
            UpdateUi();
        }

        private void StopServer()
        {
            _server.Stop();
            _state = _state == ServerState.NotSetUp ? ServerState.NotSetUp : ServerState.Stopped;
            UpdateUi();
        }

        private void OnServerExited(ServerExitedEventArgs e)
        {
            if (e.Requested) return;
            _state = ServerState.Error;
            _lastError = _server.LastError() ?? ("Сервер завершился с кодом " + e.ExitCode + ".");
            Balloon("Сервер остановился: " + _lastError, ToolTipIcon.Error);
            UpdateUi();
        }

        private async Task PollAsync()
        {
            if (_polling || _state == ServerState.NotSetUp) return;
            _polling = true;
            try
            {
                _health = await Health.CheckAsync(_port);
                var own = _server.IsRunning;
                if (own)
                {
                    if (_health.IsOurs)
                    {
                        _state = ServerState.Running;
                        if (!_health.AiReady && !_aiWarned)
                        {
                            _aiWarned = true;
                            Balloon("Сервер запущен, но AI не готов: " + (_health.Message ?? "проверьте GROQ_API_KEY в .env") +
                                    " Меню → «Настройки сервера (.env)», затем «Перезапустить».", ToolTipIcon.Warning);
                        }
                    }
                    else if ((DateTime.Now - _startedAt).TotalSeconds > 30)
                    {
                        _state = ServerState.Error;
                        _lastError = "Сервер не отвечает. Откройте журнал.";
                    }
                    else
                    {
                        _state = ServerState.Starting;
                    }
                }
                else if (_state != ServerState.Error)
                {
                    _state = _health.IsOurs ? ServerState.External
                        : _health.Reachable ? ServerState.PortBusy
                        : ServerState.Stopped;
                }
            }
            finally
            {
                _polling = false;
                UpdateUi();
            }
        }

        /* ---------------- UI ---------------- */

        private void UpdateUi()
        {
            string status;
            Icon icon;
            switch (_state)
            {
                case ServerState.NotSetUp:
                    status = "Не настроено"; icon = _iconStopped; break;
                case ServerState.Starting:
                    status = "Сервер запускается…"; icon = _iconWarn; break;
                case ServerState.Running:
                    status = "Сервер работает · порт " + _port; icon = _health.AiReady ? _iconOk : _iconWarn; break;
                case ServerState.External:
                    status = "Сервер работает (запущен вне трея)"; icon = _health.AiReady ? _iconOk : _iconWarn; break;
                case ServerState.PortBusy:
                    status = "Порт " + _port + " занят другой программой"; icon = _iconStopped; break;
                case ServerState.Error:
                    status = "Ошибка сервера"; icon = _iconStopped; break;
                default:
                    status = "Сервер остановлен"; icon = _iconStopped; break;
            }

            string ai;
            if (_state == ServerState.NotSetUp) ai = _setupProblem;
            else if (_state == ServerState.Error) ai = _lastError;
            else if (_state == ServerState.PortBusy) ai = "Остановите её или задайте другой PORT в .env";
            else if (!_health.IsOurs) ai = "AI: —";
            else if (_health.AiReady) ai = "AI готов · " + (_health.Model ?? "");
            else ai = "AI не готов: " + (_health.Message ?? "нет API-ключа");

            _miStatus.Text = status;
            _miAi.Text = Shorten(ai, 90);
            _miAi.ToolTipText = ai;

            var running = _server.IsRunning;
            _miStart.Enabled = !running && _state != ServerState.External && _state != ServerState.Starting;
            _miStop.Enabled = running;
            _miRestart.Enabled = running;
            _miEnv.Enabled = _repo != null;
            _miLog.Enabled = File.Exists(Paths.LogFile);
            _miFolder.Visible = _repo == null;

            if (_tray.Icon != icon) _tray.Icon = icon;
            // NotifyIcon.Text is limited to 63 characters on .NET Framework.
            _tray.Text = Shorten(AppName + " — " + status, 63);
        }

        private void Balloon(string text, ToolTipIcon kind)
        {
            if (string.IsNullOrEmpty(text)) return;
            _tray.ShowBalloonTip(8000, AppName, Shorten(text, 250), kind);
        }

        private static string Shorten(string s, int max) =>
            string.IsNullOrEmpty(s) || s.Length <= max ? s ?? "" : s.Substring(0, max - 1) + "…";

        private static Icon LoadIcon(string name)
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (stream == null) return SystemIcons.Application;
                return new Icon(stream, SystemInformation.SmallIconSize);
            }
        }

        /* ---------------- actions ---------------- */

        private void OpenEnv()
        {
            if (_repo == null) return;
            var env = Paths.EnvFile(_repo);
            try
            {
                if (!File.Exists(env) && File.Exists(Paths.EnvExample(_repo))) File.Copy(Paths.EnvExample(_repo), env);
                Process.Start(new ProcessStartInfo("notepad.exe", "\"" + env + "\"") { UseShellExecute = true });
                Balloon("После сохранения .env выберите «Перезапустить сервер».", ToolTipIcon.Info);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is System.ComponentModel.Win32Exception)
            {
                Balloon("Не удалось открыть .env: " + ex.Message, ToolTipIcon.Error);
            }
        }

        private void OpenLog()
        {
            try { Process.Start(new ProcessStartInfo("notepad.exe", "\"" + Paths.LogFile + "\"") { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception ex) { Balloon(ex.Message, ToolTipIcon.Error); }
        }

        private void Open(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception ex) { Balloon(ex.Message, ToolTipIcon.Error); }
        }

        private static bool IsAutostart()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key?.GetValue(RunValue) is string;
        }

        private void SetAutostart(bool enable)
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (enable) key.SetValue(RunValue, "\"" + Application.ExecutablePath + "\"");
                    else key.DeleteValue(RunValue, false);
                }
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException || ex is System.Security.SecurityException || ex is IOException)
            {
                Balloon("Не удалось изменить автозапуск: " + ex.Message, ToolTipIcon.Error);
            }
        }

        private void ExitApp()
        {
            _timer.Stop();
            _server.Dispose();
            _tray.Visible = false;
            _tray.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Dispose();
                _server.Dispose();
                _tray.Dispose();
                _ui.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
