Add-Type -Assembly System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$img.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
