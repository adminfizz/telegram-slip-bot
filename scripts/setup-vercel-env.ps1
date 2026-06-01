param(
  [string]$Environment = "production"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Read-DotEnv {
  param([string]$Path)
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }

    $parts = $line.Split("=", 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($key) { $values[$key] = $value }
  }

  return $values
}

function Add-VercelEnv {
  param(
    [string]$Name,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    Write-Host "Skip $Name (empty)"
    return
  }

  Write-Host "Setting $Name for $Environment..."
  $Value | npx vercel env add $Name $Environment
}

$envFile = Join-Path $ProjectRoot ".env"
$credentialsFile = Join-Path $ProjectRoot "credentials.json"
$tokenFile = Join-Path $ProjectRoot "tokens\google_token.json"

$envValues = Read-DotEnv $envFile

Push-Location $ProjectRoot
try {
  Add-VercelEnv "TELEGRAM_BOT_TOKEN" $envValues["TELEGRAM_BOT_TOKEN"]
  Add-VercelEnv "GEMINI_API_KEY" $envValues["GEMINI_API_KEY"]
  Add-VercelEnv "SPREADSHEET_ID" $envValues["SPREADSHEET_ID"]
  Add-VercelEnv "SUMMARY_CHAT_ID" $envValues["SUMMARY_CHAT_ID"]
  $dashboardUser = if ($envValues.ContainsKey("DASHBOARD_USER")) { $envValues["DASHBOARD_USER"] } else { "admin" }
  $dashboardPass = if ($envValues.ContainsKey("DASHBOARD_PASS")) { $envValues["DASHBOARD_PASS"] } else { "admin" }
  Add-VercelEnv "DASHBOARD_USER" $dashboardUser
  Add-VercelEnv "DASHBOARD_PASS" $dashboardPass
  Add-VercelEnv "ALLOWED_CHAT_IDS" $envValues["ALLOWED_CHAT_IDS"]

  if (Test-Path $credentialsFile) {
    Add-VercelEnv "GOOGLE_CREDENTIALS_JSON" (Get-Content $credentialsFile -Raw)
  }

  if (Test-Path $tokenFile) {
    Add-VercelEnv "GOOGLE_TOKEN_JSON" (Get-Content $tokenFile -Raw)
  }
}
finally {
  Pop-Location
}
