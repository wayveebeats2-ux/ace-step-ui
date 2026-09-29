using System.Diagnostics;
using System.Net.Http;
using Microsoft.Web.WebView2.WinForms;

namespace AceStepUiLauncher;

// Portable desktop launcher: ACE-Step API + UI backend + WebView2 frontend.
internal static class Program
{
    private static readonly List<Process> Children = new();

    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.ApplicationExit += (_, _) => StopChildren();
        Application.Run(new MainForm());
    }

    private sealed class MainForm : Form
    {
        private readonly Label title = new() { AutoSize = true, Font = new Font("Segoe UI", 18, FontStyle.Bold), Text = "ACE-Step UI" };
        private readonly Label status = new() { AutoSize = true, Font = new Font("Segoe UI", 10), Text = "Starting..." };
        private readonly ProgressBar progress = new() { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25, Width = 460, Height = 18 };
        private readonly WebView2 web = new() { Dock = DockStyle.Fill, Visible = false };
        private bool ready;

        public MainForm()
        {
            Text = "ACE-Step UI";
            Width = 1280;
            Height = 820;
            MinimumSize = new Size(900, 650);
            StartPosition = FormStartPosition.CenterScreen;

            var startup = new Panel { Dock = DockStyle.Fill };
            var startupCard = new Panel { Size = new Size(500, 190) };
            title.Location = new Point(20, 12);
            status.Location = new Point(20, 68);
            progress.Location = new Point(20, 142);
            startupCard.Controls.Add(title);
            startupCard.Controls.Add(status);
            startupCard.Controls.Add(progress);
            startup.Controls.Add(startupCard);

            void CenterStartupCard()
            {
                startupCard.Left = Math.Max(0, (startup.ClientSize.Width - startupCard.Width) / 2);
                startupCard.Top = Math.Max(0, (startup.ClientSize.Height - startupCard.Height) / 2);
            }
            startup.Resize += (_, _) => CenterStartupCard();
            CenterStartupCard();
            Controls.Add(web);
            Controls.Add(startup);

            Shown += async (_, _) =>
            {
                try
                {
                    await StartEverything(SetStatus);
                    SetStatus("Ready");
                    await web.EnsureCoreWebView2Async();
                    web.CoreWebView2.Navigate("http://127.0.0.1:3000");
                    startup.Visible = false;
                    web.Visible = true;
                    ready = true;
                }
                catch (Exception ex)
                {
                    progress.Style = ProgressBarStyle.Blocks;
                    status.Text = "Startup failed.";
                    MessageBox.Show(ex.Message, "ACE-Step UI", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            };

            FormClosing += (_, _) => StopChildren();
        }

        private void SetStatus(string value)
        {
            if (InvokeRequired) { BeginInvoke(() => SetStatus(value)); return; }
            status.Text = value;
        }
    }

    private static async Task StartEverything(Action<string> status)
    {
        var root = AppContext.BaseDirectory;
        var engine = FindEngine(root) ?? throw new InvalidOperationException(
            "ACE-Step-1.5 was not found.\n\nPlace the official Windows portable ACE-Step-1.5 folder next to ACE-Step UI.exe (or inside an 'engine' folder), then launch again.");

        var python = Path.Combine(engine, "python_embeded", "python.exe");
        var apiServer = Path.Combine(engine, "acestep", "api_server.py");
        var node = Path.Combine(root, "runtime", "node", "node.exe");
        var server = Path.Combine(root, "app", "server", "dist", "index.js");
        var vite = Path.Combine(root, "app", "node_modules", "vite", "bin", "vite.js");

        if (!File.Exists(python) || !File.Exists(apiServer))
            throw new InvalidOperationException("The detected ACE-Step folder is incomplete. Use the official Windows portable package.");
        if (!File.Exists(node) || !File.Exists(server) || !File.Exists(vite))
            throw new InvalidOperationException("The portable UI runtime is incomplete. Re-extract the release ZIP.");

        status("✓ Portable engine found\n⟳ Loading ACE-Step models…");
        Start(python, $"{Quote(apiServer)} --host 127.0.0.1 --port 8001", engine,
            new Dictionary<string, string> { ["ACESTEP_USE_FLASH_ATTENTION"] = "false" });

        // ACE-Step can return 404 at / while healthy; /health is preferred.
        if (!await WaitFor("http://127.0.0.1:8001/health", TimeSpan.FromMinutes(15)))
            throw new TimeoutException("ACE-Step did not become ready within 15 minutes. Model downloads or first-run initialization may still be in progress.");

        status("✓ ACE-Step API ready\n⟳ Starting UI backend…");
        Start(node, Quote(server), Path.Combine(root, "app", "server"));
        if (!await WaitFor("http://127.0.0.1:3001/health", TimeSpan.FromMinutes(2)))
            throw new InvalidOperationException("ACE-Step UI backend failed to start.");

        status("✓ ACE-Step API ready\n✓ UI backend ready\n⟳ Starting desktop UI…");
        Start(node, $"{Quote(vite)} preview --host 127.0.0.1 --port 3000", Path.Combine(root, "app"));
        if (!await WaitFor("http://127.0.0.1:3000", TimeSpan.FromMinutes(2)))
            throw new InvalidOperationException("ACE-Step UI frontend failed to start.");
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

    private static void Start(string file, string args, string cwd, Dictionary<string, string>? env = null)
    {
        var psi = new ProcessStartInfo(file, args)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = false,
            RedirectStandardError = false
        };
        if (env != null)
            foreach (var pair in env) psi.Environment[pair.Key] = pair.Value;

        var p = Process.Start(psi);
        if (p != null) Children.Add(p);
    }

    private static async Task<bool> WaitFor(string url, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            try
            {
                using var response = await client.GetAsync(url);
                if ((int)response.StatusCode < 500) return true;
            }
            catch { }
            await Task.Delay(1000);
        }
        return false;
    }

    private static string Quote(string value) => $"\"{value}\"";

    private static void StopChildren()
    {
        foreach (var p in Children.AsEnumerable().Reverse())
        {
            try { if (!p.HasExited) p.Kill(true); } catch { }
            try { p.Dispose(); } catch { }
        }
        Children.Clear();
    }
}
