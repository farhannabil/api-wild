# Called only by the protected controller; its stdout is captured in memory.
$ErrorActionPreference = 'Stop'
$secure = Import-Clixml -LiteralPath 'C:\Users\farha\.claude\setup-runtime\credentials\apiwild-github.clixml'
if ($secure -isnot [System.Security.SecureString]) { throw 'Encrypted GitHub credential unavailable.' }
$pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
