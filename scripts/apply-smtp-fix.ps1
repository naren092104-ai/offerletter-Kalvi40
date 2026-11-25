$path = 'E:\offerletter-Kalvi40-main\worker\index.ts'
$text = [System.IO.File]::ReadAllText($path)
$old = "  const senderEmail = settings.get('sender_email') || 'prem@bumbleb.org.in';`r`n  return {"
$new = "  const senderEmail = settings.get('sender_email') || 'prem@bumbleb.org.in';`r`n  const credentialsConfigured = Boolean(host && username && passwordConfigured && senderEmail);`r`n  const verified = settings.get('smtp_verified') === 'true';`r`n  const legacyCompatible = credentialsConfigured && !settings.has('smtp_verified');`r`n  return {"
$text = $text.Replace($old, $new)
$text = $text.Replace("    provider_configured: Boolean(host && username && passwordConfigured && senderEmail),", "    provider_configured: verified || legacyCompatible,")
$oldTest = @"
      try {
        await recordAdminActivity(supabase, request, session, 'EMAIL_CONNECTION_TEST', 'settings', result.ok
          ? `Verified ${result.provider} connection: ${result.accountInfo}`
          : `Connection test failed (${result.provider}): ${result.error}`);
      } catch (error) {
"@
$newTest = @"
      if (result.ok) {
        await supabase.from('system_settings').upsert(
          { key: 'smtp_verified', value: 'true', updated_at: now() },
          { onConflict: 'key' },
        );
      } else {
        await supabase.from('system_settings').upsert(
          { key: 'smtp_verified', value: 'false', updated_at: now() },
          { onConflict: 'key' },
        );
      }
      try {
        await recordAdminActivity(supabase, request, session, 'EMAIL_CONNECTION_TEST', 'settings', result.ok
          ? `Verified ${result.provider} connection: ${result.accountInfo}`
          : `Connection test failed (${result.provider}): ${result.error}`);
      } catch (error) {
"@
$text = $text.Replace($oldTest, $newTest)
$text = $text.Replace("      const values: Record<string, string> = { email_provider: 'smtp' };", "      const values: Record<string, string> = { email_provider: 'smtp', smtp_verified: 'false' };`r`n")
[System.IO.File]::WriteAllText($path, $text)
