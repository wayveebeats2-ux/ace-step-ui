import { existsSync } from 'fs';
import path from 'path';

export function resolvePythonPath(baseDir: string): string {
  // Allow explicit override via env var
  if (process.env.PYTHON_PATH) {
    return process.env.PYTHON_PATH;
  }

  const isWindows = process.platform === 'win32';
  const pythonExe = isWindows ? 'python.exe' : 'python';

  // Check for portable installation first (python_embeded)
  const portablePath = path.join(baseDir, 'python_embeded', pythonExe);
  if (existsSync(portablePath)) {
    return portablePath;
  }

  // Check common venv directory names (Pinokio uses 'env', others use '.venv' or 'venv')
  const venvDirs = ['env', '.venv', 'venv'];
  for (const venvDir of venvDirs) {
    const venvPython = isWindows
      ? path.join(baseDir, venvDir, 'Scripts', pythonExe)
      : path.join(baseDir, venvDir, 'bin', 'python');
    if (existsSync(venvPython)) {
      return venvPython;
    }
  }

  // Fallback to first option (will produce a clear error if not found)
  if (isWindows) {
    return path.join(baseDir, 'env', 'Scripts', pythonExe);
  }
  return path.join(baseDir, 'env', 'bin', 'python');
}

