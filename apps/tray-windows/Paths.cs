using System;
using System.IO;
using System.Text.RegularExpressions;

namespace WadTray
{
    /// <summary>Locates the project folder, node.exe and settings. Never reads anything except .env PORT.</summary>
    internal static class Paths
    {
        public static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WhatsAppAIDigest");

        public static string LogFile => Path.Combine(DataDir, "server.log");
        private static string RepoPathFile => Path.Combine(DataDir, "repo-path.txt");

        public static string ServerDir(string repo) => Path.Combine(repo, "apps", "server");
        public static string EnvFile(string repo) => Path.Combine(ServerDir(repo), ".env");
        public static string EnvExample(string repo) => Path.Combine(ServerDir(repo), ".env.example");

        public static bool IsRepo(string path) =>
            !string.IsNullOrWhiteSpace(path)
            && File.Exists(Path.Combine(path, "pnpm-workspace.yaml"))
            && File.Exists(Path.Combine(path, "apps", "server", "src", "index.ts"));

        /// <summary>1) folders above the .exe (normal case: exe inside the repo); 2) previously chosen folder.</summary>
        public static string FindRepoRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (dir != null)
            {
                if (IsRepo(dir.FullName)) return dir.FullName;
                dir = dir.Parent;
            }
            try
            {
                if (File.Exists(RepoPathFile))
                {
                    var saved = File.ReadAllText(RepoPathFile).Trim();
                    if (IsRepo(saved)) return saved;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return null;
        }

        public static void SaveRepoRoot(string path)
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(RepoPathFile, path);
        }

        public static string FindNode()
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var part in path.Split(';'))
            {
                var candidate = TryCombine(part.Trim().Trim('"'), "node.exe");
                if (candidate != null && File.Exists(candidate)) return candidate;
            }
            var roots = new[]
            {
                Environment.GetEnvironmentVariable("NVM_SYMLINK"),
                Environment.GetEnvironmentVariable("ProgramW6432") is string pf64 ? Path.Combine(pf64, "nodejs") : null,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs"),
            };
            foreach (var root in roots)
            {
                var candidate = TryCombine(root, "node.exe");
                if (candidate != null && File.Exists(candidate)) return candidate;
            }
            return null;
        }

        public static int ReadPort(string repo)
        {
            try
            {
                var env = EnvFile(repo);
                if (File.Exists(env))
                {
                    foreach (var line in File.ReadAllLines(env))
                    {
                        var m = Regex.Match(line, @"^\s*PORT\s*=\s*(\d{1,5})\s*$");
                        if (m.Success && int.TryParse(m.Groups[1].Value, out var port) && port > 0 && port < 65536) return port;
                    }
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return 3001;
        }

        private static string TryCombine(string dir, string file)
        {
            if (string.IsNullOrWhiteSpace(dir)) return null;
            try { return Path.Combine(dir, file); }
            catch (ArgumentException) { return null; }
        }
    }
}
