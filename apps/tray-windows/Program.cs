using System;
using System.Threading;
using System.Windows.Forms;

namespace WadTray
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            using (var mutex = new Mutex(true, @"Local\WhatsAppAIDigestTray", out bool createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "WhatsApp AI Digest уже запущен — значок находится в области уведомлений (рядом с часами).",
                        "WhatsApp AI Digest", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext());
                GC.KeepAlive(mutex);
            }
        }
    }
}
