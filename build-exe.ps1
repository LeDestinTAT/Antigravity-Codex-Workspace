param(
    [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $repoRoot $OutDir
$stagingDir = Join-Path $distDir "staging"
$csBuildDir = Join-Path $distDir "cs-build"

$cscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$cscPath = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cscPath) {
    throw "Could not find built-in Windows C# compiler (csc.exe) in .NET Framework v4.0.30319."
}

if (Test-Path $distDir) {
    Remove-Item $distDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "global") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "templates") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "templates\codex-delegate") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stagingDir "bin") | Out-Null
New-Item -ItemType Directory -Force -Path $csBuildDir | Out-Null

# 1. Compile windowless background launcher: dual-agent-launcher.exe (/target:winexe)
$launcherCs = Join-Path $csBuildDir "Launcher.cs"
$launcherSrc = @'
using System;
using System.Diagnostics;
using System.IO;

namespace DualAgent
{
    static class Launcher
    {
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                string homeDir = Environment.GetEnvironmentVariable("DUAL_AGENT_HOME");
                if (string.IsNullOrWhiteSpace(homeDir))
                {
                    homeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dual-agent");
                }
                string bridgeScript = Path.Combine(homeDir, "bridge.cjs");
                if (!File.Exists(bridgeScript))
                {
                    return 1;
                }

                string nodeExe = ResolveNodeExe();
                if (string.IsNullOrEmpty(nodeExe))
                {
                    return 2;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = "\"" + bridgeScript + "\"";
                psi.WorkingDirectory = homeDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                Process proc = Process.Start(psi);
                return proc != null ? 0 : 3;
            }
            catch
            {
                return 4;
            }
        }

        static string ResolveNodeExe()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfNode = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(pfNode)) return pfNode;

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathEnv.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(part)) continue;
                try
                {
                    string candidate = Path.Combine(part.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return "node.exe";
        }
    }
}
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($launcherCs, $launcherSrc, $utf8NoBom)

$launcherExe = Join-Path $stagingDir "bin\dual-agent-launcher.exe"
& $cscPath /nologo /optimize+ /target:winexe "/out:$launcherExe" $launcherCs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $launcherExe)) {
    throw "Failed to compile dual-agent-launcher.exe"
}

$repoBinDir = Join-Path $repoRoot "bin"
New-Item -ItemType Directory -Force -Path $repoBinDir | Out-Null
Copy-Item $launcherExe (Join-Path $repoBinDir "dual-agent-launcher.exe") -Force

# 2. Copy allowlisted clean files into staging
Copy-Item (Join-Path $repoRoot "deploy.cjs") (Join-Path $stagingDir "deploy.cjs") -Force
Copy-Item (Join-Path $repoRoot "install.ps1") (Join-Path $stagingDir "install.ps1") -Force
Copy-Item (Join-Path $repoRoot "global\bridge.cjs") (Join-Path $stagingDir "global\bridge.cjs") -Force
Copy-Item (Join-Path $repoRoot "global\client.cjs") (Join-Path $stagingDir "global\client.cjs") -Force
Copy-Item (Join-Path $repoRoot "templates\GEMINI.md") (Join-Path $stagingDir "templates\GEMINI.md") -Force
Copy-Item (Join-Path $repoRoot "templates\AI_HANDOFF.md") (Join-Path $stagingDir "templates\AI_HANDOFF.md") -Force
Copy-Item (Join-Path $repoRoot "templates\codex-delegate\SKILL.md") (Join-Path $stagingDir "templates\codex-delegate\SKILL.md") -Force
if (Test-Path (Join-Path $repoRoot "README.md")) {
    Copy-Item (Join-Path $repoRoot "README.md") (Join-Path $stagingDir "README.md") -Force
}

# 3. Create portable zip archive: dist/dual-agent-bundle.zip
$bundleZip = Join-Path $distDir "dual-agent-bundle.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $bundleZip)

# 4. Compile standalone self-extracting installer & CLI: dist/DualAgentSetup.exe
$setupCs = Join-Path $csBuildDir "DualAgentSetup.cs"
$setupSrc = @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace DualAgent
{
    static class SetupProgram
    {
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                string homeDir = Environment.GetEnvironmentVariable("DUAL_AGENT_HOME");
                if (string.IsNullOrWhiteSpace(homeDir))
                {
                    homeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dual-agent");
                }

                string bundleDir = Path.Combine(homeDir, "bundle");
                ExtractEmbeddedBundle(bundleDir);

                string nodeExe = ResolveNodeExe();
                if (string.IsNullOrEmpty(nodeExe))
                {
                    Console.Error.WriteLine("ERROR: Node.js ('node.exe') was not found. Please install Node.js 18+ first.");
                    return 1;
                }

                string deployScript = Path.Combine(bundleDir, "deploy.cjs");
                StringBuilder argBuilder = new StringBuilder();
                argBuilder.Append(QuoteArg(deployScript));

                if (args == null || args.Length == 0)
                {
                    argBuilder.Append(" install");
                }
                else
                {
                    foreach (string a in args)
                    {
                        argBuilder.Append(" ");
                        argBuilder.Append(QuoteArg(a));
                    }
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = argBuilder.ToString();
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.WorkingDirectory = Environment.CurrentDirectory;

                using (Process proc = Process.Start(psi))
                {
                    // Drain both streams concurrently so neither pipe can fill and block exit.
                    proc.OutputDataReceived += (sender, e) => { if (e.Data != null) Console.Out.WriteLine(e.Data); };
                    proc.ErrorDataReceived += (sender, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    proc.WaitForExit();
                    return proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("DualAgentSetup failed: " + ex.Message);
                return 1;
            }
        }

        static void ExtractEmbeddedBundle(string targetDir)
        {
            Directory.CreateDirectory(targetDir);
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream resStream = asm.GetManifestResourceStream("payload.zip"))
            {
                if (resStream == null)
                {
                    throw new InvalidOperationException("Embedded payload.zip resource not found.");
                }
                using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string fullDest = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                        string fullRoot = Path.GetFullPath(targetDir);
                        if (!fullDest.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("Zip slip detected in embedded archive.");
                        }
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(fullDest);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(fullDest));
                        using (Stream inStream = entry.Open())
                        using (FileStream outStream = new FileStream(fullDest, FileMode.Create, FileAccess.Write, FileShare.Read))
                        {
                            inStream.CopyTo(outStream);
                        }
                    }
                }
            }
        }

        static string ResolveNodeExe()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfNode = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(pfNode)) return pfNode;

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathEnv.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(part)) continue;
                try
                {
                    string candidate = Path.Combine(part.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        static string QuoteArg(string arg)
        {
            if (string.IsNullOrEmpty(arg)) return "\"\"";
            if (!arg.Contains(" ") && !arg.Contains("\"") && !arg.Contains("\t"))
            {
                return arg;
            }
            return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
'@
[System.IO.File]::WriteAllText($setupCs, $setupSrc, $utf8NoBom)

$setupExe = Join-Path $distDir "DualAgentSetup.exe"
& $cscPath /nologo /optimize+ /target:exe /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/res:$bundleZip,payload.zip" "/out:$setupExe" $setupCs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setupExe)) {
    throw "Failed to compile DualAgentSetup.exe"
}

Copy-Item $launcherExe (Join-Path $distDir "dual-agent-launcher.exe") -Force
Remove-Item $stagingDir -Recurse -Force
Remove-Item $csBuildDir -Recurse -Force

# 5. Generate SHA256SUMS.txt
$sumsFile = Join-Path $distDir "SHA256SUMS.txt"
$sumLines = @()
foreach ($file in @("DualAgentSetup.exe", "dual-agent-launcher.exe", "dual-agent-bundle.zip")) {
    $full = Join-Path $distDir $file
    $hash = (Get-FileHash $full -Algorithm SHA256).Hash.ToLowerInvariant()
    $sumLines += "$hash  $file"
}
[System.IO.File]::WriteAllText($sumsFile, ($sumLines -join "`n") + "`n", $utf8NoBom)

Write-Output "Build succeeded! Output files in $distDir :"
Get-ChildItem $distDir | Select-Object Name, Length
Get-Content $sumsFile
