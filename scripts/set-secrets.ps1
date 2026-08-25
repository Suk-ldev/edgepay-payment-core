param(
    [switch]$Generate,
    [switch]$InitializeConfigEncryptionKey
)

$ErrorActionPreference = 'Stop'

function New-SecretValue {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Set-WorkerSecret {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$PlainValue = ''
    )

    $value = $PlainValue
    if (-not $value) {
        if ($Generate -and $Name -in @('ADMIN_TOKEN', 'EPAY_KEY', 'CONFIG_ENCRYPTION_KEY', 'POLL_TRIGGER_TOKEN', 'WATCHER_TRANSPORT_SECRET')) {
            $value = New-SecretValue
            Write-Host "`n$Name（请立即复制并妥善保管；脚本不会保存它）：" -ForegroundColor Yellow
            Write-Host $value -ForegroundColor Cyan
        } else {
            $secureValue = Read-Host "请输入 $Name" -AsSecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
            try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        }
    }

    try { $value | npx wrangler secret put $Name }
    finally { Remove-Variable value -ErrorAction SilentlyContinue }
}

Set-WorkerSecret -Name 'ADMIN_TOKEN'
Set-WorkerSecret -Name 'EPAY_KEY'
Set-WorkerSecret -Name 'POLL_TRIGGER_TOKEN'
Set-WorkerSecret -Name 'WATCHER_TRANSPORT_SECRET'
if ($InitializeConfigEncryptionKey) {
    Write-Warning 'CONFIG_ENCRYPTION_KEY 用于解密 D1 插件配置；初始化后不要随登录密码一起轮换。'
    Set-WorkerSecret -Name 'CONFIG_ENCRYPTION_KEY'
}

Write-Host "`nePay V1、管理登录和轮询触发密钥已写入 Cloudflare Worker。插件与通道请在管理后台配置。" -ForegroundColor Green
