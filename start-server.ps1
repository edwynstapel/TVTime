# TV Time local server — serves the current folder on port 8080
# Double-click this file to start, close the window to stop
# Find local IP
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|VMware|vEthernet|Hyper-V' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress }
if (-not $ip) { $ip = '192.168.1.XXX' }

$prefix = "http://${ip}:8080/"
Write-Host "Binding to $prefix" -ForegroundColor Gray

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Host "ACCESS DENIED — trying with localhost prefix instead" -ForegroundColor Red
    Write-Host "If you see this, install Python from the Microsoft Store (one click):" -ForegroundColor Yellow
    Write-Host "  Start menu → Microsoft Store → search 'Python 3.13' → Install" -ForegroundColor White
    Write-Host "Then run: python -m http.server 8080" -ForegroundColor White
    pause
    exit 1
}
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " TV Time server running!" -ForegroundColor Green
Write-Host " On your iPhone, open Safari and go to:" -ForegroundColor White
Write-Host "   http://${ip}:8080/index.html" -ForegroundColor Yellow
Write-Host ""
Write-Host " Press Ctrl+C or close this window to stop" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan

$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $path = $request.Url.LocalPath.TrimStart('/')
    if ($path -eq '') { $path = 'index.html' }
    $filePath = Join-Path $folder $path

    if (Test-Path $filePath -PathType Leaf) {
        $ext = [IO.Path]::GetExtension($filePath).ToLower()
        $mime = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
        $response.ContentType = $mime
        $bytes = [IO.File]::ReadAllBytes($filePath)
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $response.StatusCode = 404
    }
    $response.Close()
}
