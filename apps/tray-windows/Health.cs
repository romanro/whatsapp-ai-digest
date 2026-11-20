using System;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace WadTray
{
    internal sealed class HealthInfo
    {
        /// <summary>Something answered HTTP on the port.</summary>
        public bool Reachable;
        /// <summary>It is our server (recognised /health JSON).</summary>
        public bool IsOurs;
        public bool AiConfigured;
        public bool? ModelAvailable;
        public string Model;
        public string Message;

        public bool AiReady => AiConfigured && ModelAvailable != false;
    }

    internal static class Health
    {
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(3),
        };

        public static async Task<HealthInfo> CheckAsync(int port)
        {
            var info = new HealthInfo();
            try
            {
                using (var res = await Http.GetAsync("http://127.0.0.1:" + port + "/health").ConfigureAwait(false))
                {
                    info.Reachable = true;
                    var json = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!res.IsSuccessStatusCode || !json.Contains("\"status\":\"ok\"") || !json.Contains("\"ai\":")) return info;
                    info.IsOurs = true;
                    info.AiConfigured = json.Contains("\"configured\":true");
                    var avail = Regex.Match(json, "\"modelAvailable\":(true|false|null)");
                    info.ModelAvailable = avail.Success && avail.Groups[1].Value != "null" ? avail.Groups[1].Value == "true" : (bool?)null;
                    info.Model = Str(json, "model");
                    info.Message = Str(json, "message");
                }
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            return info;
        }

        private static string Str(string json, string key)
        {
            var m = Regex.Match(json, "\"" + key + "\":\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
        }
    }
}
