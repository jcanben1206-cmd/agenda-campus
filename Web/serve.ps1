param(
    [ValidateRange(1024, 65535)][int]$Port = 8765,
    [switch]$Loopback,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$page = Join-Path $PSScriptRoot 'dist/index.html'
$address = if ($Loopback) { [System.Net.IPAddress]::Loopback } else { [System.Net.IPAddress]::Any }
$listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
$listener.Start()

try {
    Write-Host "En este PC: http://127.0.0.1:$Port/"
    if (!$Loopback) {
        $interfaces = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
        foreach ($adapter in $interfaces) {
            if ($adapter.OperationalStatus -ne 'Up' -or $adapter.NetworkInterfaceType -eq 'Loopback') { continue }
            foreach ($entry in $adapter.GetIPProperties().UnicastAddresses) {
                if ($entry.Address.AddressFamily -eq 'InterNetwork') {
                    Write-Host "En Safari ($($adapter.Name)): http://$($entry.Address):$Port/"
                }
            }
        }
    }
    Write-Host 'Deja esta ventana abierta durante la prueba. Pulsa Ctrl+C para terminar.'
    if ($OpenBrowser) { Start-Process "http://127.0.0.1:$Port/" }

    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 2500
            $stream.WriteTimeout = 2500
            $buffer = [byte[]]::new(8192)
            $received = 0
            $request = ''
            do {
                $count = $stream.Read($buffer, $received, $buffer.Length - $received)
                if ($count -eq 0) { break }
                $received += $count
                $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $received)
            } until ($request.Contains("`r`n`r`n") -or $received -eq $buffer.Length)

            $status = '404 Not Found'
            $type = 'text/plain; charset=utf-8'
            $body = [System.Text.Encoding]::UTF8.GetBytes('Recurso no encontrado.')
            if ($request -match '\A(?:GET|HEAD) /(?:index\.html)?(?:\?[^ ]*)? HTTP/1\.[01]\r\n') {
                $status = '200 OK'
                $type = 'text/html; charset=utf-8'
                $body = [System.IO.File]::ReadAllBytes($page)
            }
            $headers = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if (!$request.StartsWith('HEAD ')) { $stream.Write($body, 0, $body.Length) }
        } catch [System.IO.IOException] {
            # The browser may close an unused connection before sending a request.
        } finally {
            $client.Dispose()
        }
    }
} finally {
    $listener.Stop()
}
