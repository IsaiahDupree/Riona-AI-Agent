$env:INSTAGRAM_BOT_USERNAME = "the_isaiah_dupree_"
$env:INSTAGRAM_BOT_PASSWORD = "SkyCloud12!@"
$env:INSTAGRAM_PROXY_PORT = "9000"
$env:INSTAGRAM_PROXY_HOST = "localhost"
$env:USE_PROXY = "false"
$env:PROXY_ENABLED = "true"

Write-Host "Starting Instagram bot..."
node build/index.js
