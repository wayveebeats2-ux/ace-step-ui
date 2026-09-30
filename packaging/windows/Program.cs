using System.Diagnostics;
using System.Text;
using System.Net.Http;
using Microsoft.Web.WebView2.WinForms;

namespace AceStepUiLauncher;

// Portable desktop launcher: ACE-Step API + UI backend + WebView2 frontend.
// Build trigger: stacked generation-path, settings, logging, and startup updates.
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
        private readonly Label status = new() { AutoSize = false, Size = new Size(460, 118), Font = new Font("Segoe UI", 10), Text = "Starting..." };
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
            var startupCard = new Panel { Size = new Size(500, 250) };
            title.Location = new Point(20, 12);
            status.Location = new Point(20, 68);
            progress.Location = new Point(20, 202);
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
                    StopChildren();
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
        foreach (var port in new[] { 8001, 3001, 3000 })
        {
            var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
            try { probe.Start(); }
            catch (System.Net.Sockets.SocketException)
            {
                throw new InvalidOperationException($"Port {port} is already in use. Close the existing ACE-Step/UI instance before launching again.");
            }
            finally { probe.Stop(); }
        }
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

        status("✓ Portable engine found\n✓ Python runtime found\n⟳ Starting ACE-Step engine…\n⟳ Loading AI models into memory…");
        AppendLog(Path.Combine(root, "logs", "ace-step.log"), "Desktop profile: DiT=acestep-v15-turbo; LM=acestep-5Hz-lm-0.6B/PT; component, DiT and LM CPU offload enabled; adaptive tiled GPU VAE decode.");
        Start(python, $"{Quote(apiServer)} --host 127.0.0.1 --port 8001", engine,
            new Dictionary<string, string>
            {
                ["ACESTEP_USE_FLASH_ATTENTION"] = "false",
                ["PYTHONUNBUFFERED"] = "1",
                ["ACESTEP_CONFIG_PATH"] = "acestep-v15-turbo",
                ["ACESTEP_CONFIG_PATH2"] = "",
                ["ACESTEP_CONFIG_PATH3"] = "",
                // REST startup defaults DiT offload to false even on tier3.
                // These supported flags release weights between LM, DiT and VAE stages.
                ["ACESTEP_OFFLOAD_TO_CPU"] = "true",
                ["ACESTEP_OFFLOAD_DIT_TO_CPU"] = "true",
                ["ACESTEP_LM_OFFLOAD_TO_CPU"] = "true",
                ["ACESTEP_VAE_ON_CPU"] = "false",
                // The official portable .env defaults to the 1.7B LM. On an 8 GB GPU
                // ACE-Step tier3 supports the 0.6B LM, so make the portable launcher
                // deterministic instead of inheriting the heavier .env choice.
                ["ACESTEP_LM_MODEL_PATH"] = "acestep-5Hz-lm-0.6B",
                // ACE-Step recommends the PyTorch LM backend for 6-8 GB GPUs. vLLM
                // reserves a KV cache on the 3050 and can leave too little VRAM for VAE decode.
                ["ACESTEP_LM_BACKEND"] = "pt",
                ["ACESTEP_INIT_LLM"] = "auto"
            }, "ace-step.log");

        // ACE-Step can return 404 at / while healthy; /health is preferred.
        if (!await WaitFor("http://127.0.0.1:8001/health", TimeSpan.FromMinutes(15)))
            throw new TimeoutException("ACE-Step did not become ready within 15 minutes. Model downloads or first-run initialization may still be in progress.");

        status("✓ Portable engine found\n✓ AI models loaded\n✓ ACE-Step API ready\n⟳ Starting local library & UI backend…");
        Start(node, Quote(server), Path.Combine(root, "app", "server"),
            new Dictionary<string, string>
            {
                ["ACESTEP_PATH"] = engine,
                ["PYTHON_PATH"] = python,
                ["ACESTEP_API_URL"] = "http://127.0.0.1:8001"
            }, "backend.log");
        if (!await WaitFor("http://127.0.0.1:3001/health", TimeSpan.FromMinutes(2)))
            throw new InvalidOperationException("ACE-Step UI backend failed to start.");

        status("✓ AI models loaded\n✓ ACE-Step API ready\n✓ Local library & backend ready\n⟳ Starting desktop interface…");
        Start(node, $"{Quote(vite)} preview --host 127.0.0.1 --port 3000 --strictPort", Path.Combine(root, "app"));
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

    private static void Start(string file, string args, string cwd, Dictionary<string, string>? env = null, string? logFile = null)
    {
        var psi = new ProcessStartInfo(file, args)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = logFile != null,
            RedirectStandardError = logFile != null,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        if (env != null)
            foreach (var pair in env) psi.Environment[pair.Key] = pair.Value;

        var p = Process.Start(psi);
        if (p != null)
        {
            if (logFile != null)
            {
                var logPath = Path.Combine(AppContext.BaseDirectory, "logs", logFile);
                Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
                p.OutputDataReceived += (_, e) => { if (e.Data != null) AppendLog(logPath, e.Data); };
                p.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendLog(logPath, e.Data); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }
            Children.Add(p);
        }
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
                if (response.IsSuccessStatusCode) return true;
            }
            catch { }
            await Task.Delay(1000);
        }
        return false;
    }

    private static readonly object LogLock = new();

    private static void AppendLog(string path, string line)
    {
        lock (LogLock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {line}{Environment.NewLine}", Encoding.UTF8);
        }
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
