const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = 43127;
let serverProcess;
let mainWindow;

function healthCheck() {
  return new Promise(resolve => {
    const request = http.get(`http://${HOST}:${PORT}/api/health`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(700, () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function startLocalServer() {
  if (await healthCheck()) return;
  const serverPath = path.join(__dirname, 'server.js');
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST, PORT: String(PORT) },
    stdio: 'ignore'
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await healthCheck()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('本地服务启动失败，请检查端口 43127 是否被占用');
}

async function createWindow() {
  try {
    await startLocalServer();
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1080,
      minHeight: 720,
      title: 'Camera Angle Studio 2.0.0',
      backgroundColor: '#08080a',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await mainWindow.loadURL(`http://${HOST}:${PORT}/?desktop=2.0.0`);
  } catch (error) {
    dialog.showErrorBox('Camera Angle Studio 启动失败', error.message);
    app.quit();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (serverProcess && !serverProcess.killed) serverProcess.kill(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
