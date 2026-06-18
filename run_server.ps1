param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8000,
  [string]$LogPath = ""
)

Set-Location -LiteralPath $PSScriptRoot
if ($LogPath) {
  python .\app.py --host $HostName --port $Port *>> $LogPath
} else {
  python .\app.py --host $HostName --port $Port
}
