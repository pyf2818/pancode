# Add Defender exclusions for pancode build (requires admin via UAC)
$ErrorActionPreference = "Stop"
try {
  Add-MpPreference -ExclusionPath "E:\VStudio_Project\ai\pancode"
  Add-MpPreference -ExclusionProcess "node.exe"
  $mp = $null
  try { $mp = (Get-MpPreference).ExclusionPath -join "; " } catch { $mp = "hidden" }
  "DONE exclusions=[$mp]" | Out-File "E:\VStudio_Project\ai\pancode\scripts\_excl_done.txt" -Encoding utf8
} catch {
  "FAIL " + $_.Exception.Message | Out-File "E:\VStudio_Project\ai\pancode\scripts\_excl_done.txt" -Encoding utf8
}
