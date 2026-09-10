# Set up invoice-by-email. Run this from the project folder:
#
#     powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\setup.ps1
#
# It invents the shared key itself, stores it as a Supabase secret, deploys the function, and
# prints the one URL you need to paste into Resend. The key is never written to a file and never
# leaves this machine except as a Supabase secret, so it cannot end up in the public repo.
#
# You will be asked to sign in to Supabase in a browser once. Nothing here needs your database
# password.

$ErrorActionPreference = 'Stop'
$PROJECT = 'vzxenkijxzzrgnmopnxh'
$RECEIVE = 'inbox.sydneylvl.com,sydneylvl.com'

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }

Step 1 "Checking the Supabase CLI"
# npx fetches it on demand, so there is nothing to install and nothing left behind.
try { $null = & npx --yes supabase@latest --version 2>&1 }
catch { Write-Host "Could not run the Supabase CLI through npx. Is Node installed?" -ForegroundColor Red; exit 1 }
Write-Host "    ok"

Step 2 "Signing in to Supabase (a browser window will open)"
& npx --yes supabase@latest login
if ($LASTEXITCODE -ne 0) { Write-Host "Sign-in did not complete." -ForegroundColor Red; exit 1 }

Step 3 "Inventing a key for the mail provider to use"
# 32 random bytes as hex. This is the only thing standing between the open internet and the
# invoice queue, so it is made here rather than chosen by a person.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$KEY = -join ($bytes | ForEach-Object { $_.ToString('x2') })
Write-Host "    made one"

Step 4 "Storing it, and which addresses we are willing to receive at"
& npx --yes supabase@latest secrets set "INBOUND_KEY=$KEY" "INBOUND_TO=$RECEIVE" --project-ref $PROJECT
if ($LASTEXITCODE -ne 0) { Write-Host "Could not store the secrets." -ForegroundColor Red; exit 1 }

Step 5 "Deploying the function"
# --no-verify-jwt is required: a mail provider has no Supabase token to send, which is why the
# function checks the key itself.
& npx --yes supabase@latest functions deploy inbound-email --no-verify-jwt --project-ref $PROJECT
if ($LASTEXITCODE -ne 0) { Write-Host "Deploy failed." -ForegroundColor Red; exit 1 }

$URL = "https://$PROJECT.supabase.co/functions/v1/inbound-email?key=$KEY"

Write-Host ""
Write-Host "Deployed. The server side is now complete." -ForegroundColor Green
Write-Host ""
Write-Host "  You do NOT need the URL below unless you are wiring up a mail provider by hand." -ForegroundColor DarkGray
Write-Host "  $URL" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Next, and this is the only step left:" -ForegroundColor Green
Write-Host ""
Write-Host "     powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\make-gmail-script.ps1"
Write-Host ""
Write-Host "  That writes a finished Gmail collector to your Desktop with its own key already in"
Write-Host "  it, and opens it. Copy the whole file, paste it over the code in script.google.com,"
Write-Host "  save, and run testConnection. There is nothing to edit by hand."
Write-Host ""
Write-Host "  (It mints its own key, which retires the one above - so do not paste that anywhere.)" -ForegroundColor DarkGray
Write-Host ""
