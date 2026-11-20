using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace WadTray
{
    /// <summary>
    /// Runs `node --use-system-ca --import tsx src/index.ts` (system CA store: works behind TLS-inspecting corporate proxies) in apps/server as a single hidden process.
    /// Output goes to %LOCALAPPDATA%\WhatsAppAIDigest\server.log (the server never logs message contents).
    /// </summary>
    internal sealed class ServerProcess : IDisposable
    {
        private readonly object _lock = new object();
        private readonly Queue<string> _tail = new Queue<string>();
        private readonly JobObject _job = new JobObject();
        private Process _process;
        private StreamWriter _log;

        /// <summary>Raised on a thread-pool thread after the process exited and its output was drained.</summary>
        public event EventHandler<ServerExitedEventArgs> Exited;

        public bool IsRunning
        {
            get { lock (_lock) return _process != null && !_process.HasExited; }
        }

        public void Start(string nodeExe, string serverDir)
        {
            lock (_lock)
            {
                if (_process != null && !_process.HasExited) return;
                Directory.CreateDirectory(Paths.DataDir);
                _log?.Dispose();
                _log = new StreamWriter(
                    new FileStream(Paths.LogFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite),
                    new UTF8Encoding(false)) { AutoFlush = true };
                _tail.Clear();

                var psi = new ProcessStartInfo(nodeExe, "--use-system-ca --import tsx src/index.ts")
                {
                    WorkingDirectory = serverDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                psi.EnvironmentVariables["NO_COLOR"] = "1";

                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => OnLine(e.Data);
                p.ErrorDataReceived += (s, e) => OnLine(e.Data);
                p.Exited += (s, e) => OnExited(p);
                p.Start();
                _job.Assign(p);
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                _process = p;
            }
        }

        /// <summary>Stops the server. Returns once it has exited (max ~5 s).</summary>
        public void Stop()
        {
            Process p;
            lock (_lock)
            {
                p = _process;
                _process = null;
            }
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    p.Kill();
                    p.WaitForExit(5000);
                }
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }

        public string[] Tail()
        {
            lock (_lock) return _tail.ToArray();
        }

        /// <summary>Most relevant error message from the pino JSON log (level ≥ 50), or the last stderr line.</summary>
        public string LastError()
        {
            var lines = Tail();
            for (var i = lines.Length - 1; i >= 0; i--)
            {
                var line = lines[i];
                var level = Regex.Match(line, "\"level\":(\\d+)");
                if (level.Success && int.Parse(level.Groups[1].Value) >= 50)
                {
                    var msg = Regex.Match(line, "\"msg\":\"((?:[^\"\\\\]|\\\\.)*)\"");
                    if (msg.Success) return Regex.Unescape(msg.Groups[1].Value);
                }
            }
            for (var i = lines.Length - 1; i >= 0; i--)
            {
                var line = lines[i].Trim();
                if (line.Length > 0 && !line.StartsWith("{", StringComparison.Ordinal) && !line.StartsWith("at ", StringComparison.Ordinal))
                    return line;
            }
            return null;
        }

        private void OnLine(string line)
        {
            if (line == null) return;
            lock (_lock)
            {
                try { _log?.WriteLine(line); }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                _tail.Enqueue(line);
                while (_tail.Count > 60) _tail.Dequeue();
            }
        }

        private void OnExited(Process p)
        {
            bool expected;
            int code;
            try
            {
                p.WaitForExit(); // drain async output so LastError() sees the final lines
                code = p.ExitCode;
            }
            catch (InvalidOperationException)
            {
                code = -1;
            }
            lock (_lock)
            {
                // If Stop() was called, _process was already cleared → exit was requested.
                expected = !ReferenceEquals(_process, p);
                if (!expected) _process = null;
            }
            Exited?.Invoke(this, new ServerExitedEventArgs(code, expected));
        }

        public void Dispose()
        {
            Stop();
            _job.Dispose();
            lock (_lock)
            {
                _log?.Dispose();
                _log = null;
            }
        }
    }

    internal sealed class ServerExitedEventArgs : EventArgs
    {
        public ServerExitedEventArgs(int exitCode, bool requested)
        {
            ExitCode = exitCode;
            Requested = requested;
        }

        public int ExitCode { get; }
        public bool Requested { get; }
    }
}
