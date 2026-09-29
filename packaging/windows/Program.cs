using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Diagnostics;
using System.Net;

namespace AceStepUiLauncher;

internal static class Program
{
    private static readonly List<Process> Children = new();

    [STAThread]
    private static async Task Main()
    {
        var root = AppContext.BaseDirectory;
        var engine = FindEngine(root);
        var node = Path.Combine(root, "runtime", "node", "node.exe");
        var server = Path.Combine(root, "app", "server", "dist", "index.js");
        var vite = Path.Combine(root, "app", "node_modules", "vite", "bin", "vite.js");

        if (engine is null)
        {
            MessageBox.Show(
                "ACE-Step-1.5 was not found.\n\nPlace the official Windows portable ACE-Step-1.5 folder next to ACE-Step UI.exe (or inside an 'engine' folder), then launch again.",
                "ACE-Step UI", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (!File.Exists(node) || !File.Exists(server) || !File.Exists(vite))
        {
            MessageBox.Show("The portable UI runtime is incomplete. Re-extract the release ZIP.", "ACE-Step UI",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Application.ApplicationExit += (_, _) => StopChildren();

        var python = Path.Combine(engine, "python_embeded", "python.exe");
        if (!File.Exists(python))
        {
            MessageBox.Show("The detected ACE-Step folder does not contain python_embeded\\python.exe. Use the official Windows portable package.",
                "ACE-Step UI", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Start(python, "-m acestep --port 8001 --enable-api --backend pt --server-name 127.0.0.1", engine);
        if (!await WaitFor("http://127.0.0.1:8001", TimeSpan.FromMinutes(5)))
        {
            MessageBox.Show("ACE-Step did not become ready in time. Close the launcher and try again.", "ACE-Step UI",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            StopChildren();
            return;
        }

        Start(node, Quote(server), Path.Combine(root, "app", "server"));
        if (!await WaitFor("http://127.0.0.1:3001/health", TimeSpan.FromSeconds(45)))
        {
            MessageBox.Show("ACE-Step UI backend failed to start.", "ACE-Step UI",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            StopChildren();
            return;
        }

        Start(node, $"{Quote(vite)} preview --host 127.0.0.1 --port 3000", Path.Combine(root, "app"));
        if (!await WaitFor("http://127.0.0.1:3000", TimeSpan.FromSeconds(45)))
        {
            MessageBox.Show("ACE-Step UI frontend failed to start.", "ACE-Step UI",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            StopChildren();
            return;
        }

        Process.Start(new ProcessStartInfo("http://127.0.0.1:3000") { UseShellExecute = true });
        Application.Run(new LauncherContext());
    }

    private static string? FindEngine(string root)
    {
        var candidates = new[]
        {
            Path.Combine(root, "ACE-Step-1.5"),
            Path.Combine(root, "engine", "ACE-Step-1.5"),
            Path.GetFullPath(Path.Combine(root, "..", "ACE-Step-1.5"))
        };
        return candidates.FirstOrDefault(p => File.Exists(Path.Combine(p, "python_embeded", "python.exe")));
    }

    private static void Start(string file, string args, string cwd)
    {
        var p = Process.Start(new ProcessStartInfo(file, args)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
        if (p != null) Children.Add(p);
    }

    private static async Task<bool> WaitFor(string url, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            try
            {
                using var r = await client.GetAsync(url);
                if ((int)r.StatusCode < 500) return true;
            }
            catch { }
            await Task.Delay(1000);
        }
        return false;
    }

    private static string Quote(string s) => $"\"{s}\"";

    private static void StopChildren()
    {
        foreach (var p in Children.AsEnumerable().Reverse())
        {
            try { if (!p.HasExited) p.Kill(true); } catch { }
        }
    }

    private sealed class LauncherContext : ApplicationContext
    {
        private readonly NotifyIcon tray;
        public LauncherContext()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open ACE-Step UI", null, (_, _) =>
                Process.Start(new ProcessStartInfo("http://127.0.0.1:3000") { UseShellExecute = true }));
            menu.Items.Add("Exit", null, (_, _) => ExitThread());

            tray = new NotifyIcon
            {
                Text = "ACE-Step UI",
                Icon = SystemIcons.Application,
                Visible = true,
                ContextMenuStrip = menu
            };
            tray.DoubleClick += (_, _) =>
                Process.Start(new ProcessStartInfo("http://127.0.0.1:3000") { UseShellExecute = true });
        }

        protected override void ExitThreadCore()
        {
            tray.Visible = false;
            tray.Dispose();
            StopChildren();
            base.ExitThreadCore();
        }
    }
}
