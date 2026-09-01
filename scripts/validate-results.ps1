param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [double]$MaximumGapSeconds = 30
)

$captures = Get-ChildItem -LiteralPath $Path -File -Filter '*.csv'
if (!$captures) { throw "No CSV files found in $Path" }

$violations = @()
foreach ($capture in $captures) {
  $rows = @(Import-Csv -LiteralPath $capture.FullName | Sort-Object { [DateTimeOffset]::Parse($_.timestamp) })
  if ($rows.Count -lt 2) {
    Write-Output "$($capture.Name): fewer than two samples; no gap to validate."
    continue
  }
  $gaps = for ($i = 1; $i -lt $rows.Count; $i++) {
    [PSCustomObject]@{
      File = $capture.Name
      From = $rows[$i - 1].timestamp
      To = $rows[$i].timestamp
      GapSeconds = ([DateTimeOffset]::Parse($rows[$i].timestamp) - [DateTimeOffset]::Parse($rows[$i - 1].timestamp)).TotalSeconds
    }
  }
  $largest = $gaps | Sort-Object GapSeconds -Descending | Select-Object -First 1
  Write-Output ("{0}: {1} samples; largest gap {2:N3}s" -f $capture.Name, $rows.Count, $largest.GapSeconds)
  $violations += @($gaps | Where-Object { $_.GapSeconds -gt $MaximumGapSeconds })
}

if ($violations.Count) {
  $violations | Sort-Object GapSeconds -Descending | Format-Table File, From, To, @{ Label = 'GapSeconds'; Expression = { '{0:N3}' -f $_.GapSeconds } } -AutoSize | Out-String | Write-Error
  throw "$($violations.Count) gap(s) exceeded the $MaximumGapSeconds-second limit."
}

Write-Output "PASS: no recorded gap exceeded $MaximumGapSeconds seconds."
