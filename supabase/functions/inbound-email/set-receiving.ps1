# Change which addresses the function is willing to receive at, without disturbing the key.
#
#     powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\set-receiving.ps1
#
# Use this when the receiving address changes - for instance when using a Resend-managed
# subdomain (something.resend.app) instead of a domain of your own, which needs no DNS at all.
#
# Only INBOUND_TO is written. INBOUND_KEY is left exactly as it is, so the webhook URL you
# already have keeps working.

$ErrorActionPreference = 'Stop'
$PROJECT = 'vzxenkijxzzrgnmopnxh'

Write-Host ""
Write-Host "Which domain will invoices arrive at?"
Write-Host "In Resend: Emails -> Receiving -> the three dots -> Receiving address." -ForegroundColor DarkGray
Write-Host "Enter just the domain part, e.g.  abc123.resend.app" -ForegroundColor DarkGray
$dom = (Read-Host "Domain").Trim().TrimStart('@')
if ([string]::IsNullOrWhiteSpace($dom) -or $dom -notmatch '\.') {
  Write-Host "That does not look like a domain." -ForegroundColor Red; exit 1
}

# sydneylvl.com stays on the list so that anything routed the old way still gets in, and so
# switching to a domain of your own later needs no change here.
$list = "$dom,sydneylvl.com,inbox.sydneylvl.com"

Write-Host ""
Write-Host "Setting INBOUND_TO to: $list" -ForegroundColor Cyan
& npx --yes supabase@latest secrets set "INBOUND_TO=$list" --project-ref $PROJECT
if ($LASTEXITCODE -ne 0) { Write-Host "Could not set it." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Done. The key was not touched, so your existing webhook URL still works." -ForegroundColor Green
Write-Host "Mail addressed to anything at $dom will now be accepted." -ForegroundColor Green
Write-Host ""
