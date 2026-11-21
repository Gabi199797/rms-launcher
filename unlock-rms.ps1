param([string]$List,[string]$Mode)
$sid = New-Object Security.Principal.SecurityIdentifier 'S-1-1-0'
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::WriteAttributes,[Security.AccessControl.AccessControlType]::Deny)
$sec = [Security.AccessControl.AccessControlSections]::Access
if ($List -like '*.json') { $paths = Get-Content -LiteralPath $List -Raw -Encoding UTF8 | ConvertFrom-Json } else { $paths = Get-Content -LiteralPath $List -Encoding UTF8 }
foreach ($p in $paths) {
  if (-not $p) { continue }
  try {
    if (Test-Path -LiteralPath $p -PathType Container) { $a = [IO.Directory]::GetAccessControl($p, $sec) } elseif (Test-Path -LiteralPath $p) { $a = [IO.File]::GetAccessControl($p, $sec) } else { continue }
    if ($Mode -eq 'add') { $a.AddAccessRule($rule) } else { [void]$a.RemoveAccessRule($rule) }
    if (Test-Path -LiteralPath $p -PathType Container) { [IO.Directory]::SetAccessControl($p, $a) } else { [IO.File]::SetAccessControl($p, $a) }
  } catch {}
}
