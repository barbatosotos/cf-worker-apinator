# cf-worker-apinator
cmd
curl -X POST https://xxxx.workers.dev/trigger -H "Content-Type: application/json" -d "{\"channel\":\"test-channel\",\"event\":\"hello\",\"data\":{\"message\":\"Halo!\"}}"
powershell
Invoke-RestMethod -Method POST `
  -Uri "https://xxx.workers.dev/trigger" `
  -ContentType "application/json" `
  -Body '{"channel":"test-channel","event":"hello","data":{"message":"Halo!"}}'
