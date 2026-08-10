<# DeepSeek Balance Widget - Whale Ball #>
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;
public class Dwm {
  [DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int X,int Y,int W,int H,uint flags);
  [DllImport("gdi32.dll")]public static extern IntPtr CreateRoundRectRgn(int x1,int y1,int x2,int y2,int rw,int rh);
  [DllImport("gdi32.dll")]public static extern IntPtr CreateEllipticRgn(int x1,int y1,int x2,int y2);
  [DllImport("user32.dll")]public static extern int SetWindowRgn(IntPtr hwnd,IntPtr rgn,bool redraw);
  [DllImport("user32.dll")]public static extern bool ReleaseCapture();
  [DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp);
  public static readonly IntPtr HWND_TOPMOST=new IntPtr(-1);
  public const uint SWP_NOSIZE=0x0001,SWP_NOMOVE=0x0002,SWP_SHOWWINDOW=0x0040,SWP_NOACTIVATE=0x0010;
  public const uint WM_NCLBUTTONDOWN=0x00A1;
  public const int HT_CAPTION=0x2;
}
"@

$FULL_W=190;$FULL_H=190;$BALL_R=62
$W=$FULL_W;$H=$FULL_H

$f=New-Object System.Windows.Forms.Form
$f.Size=New-Object System.Drawing.Size($W,$H)
$f.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None
$f.ShowInTaskbar=$false
$f.TopMost=$true
$f.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual
$scr=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Location=New-Object System.Drawing.Point([int]($scr.Width-$W-30),[int]($scr.Height-$H-40))
$f.GetType().GetProperty('DoubleBuffered',[System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($f,$true,$null)

$balance=@{total=0.0;granted=0.0;topped=0.0;pct=100;available=$true;error=''}
$KEY=''  # 在这里填入你的 DeepSeek API Key

# Window shape helper
function SetShape($w,$h,$isBall){
  if($isBall){
    $rgn=[Dwm]::CreateEllipticRgn(0,0,$w+1,$h+1)
  }else{
    $rgn=[Dwm]::CreateRoundRectRgn(0,0,$w+1,$h+1,20,20)
  }
  [Dwm]::SetWindowRgn($f.Handle,$rgn,$true)|Out-Null
}

$f.Add_Shown({SetShape $W $H $false})

# ── Paint: ball mode vs full mode ──
$f.Add_Paint({
  $g=$_.Graphics
  $g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $w=$f.ClientRectangle.Width;$h=$f.ClientRectangle.Height
  $tag=$f.Tag
  $isBall=if($tag.anim){$tag.anim.toBall}else{$tag.ball}

  if($isBall){
    # Ball mode: smooth circle with anti-aliased edge
    $g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $brush=New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      (New-Object System.Drawing.Point(0,0)),(New-Object System.Drawing.Point($w,$h)),
      [System.Drawing.Color]::FromArgb(240,248,255),[System.Drawing.Color]::FromArgb(180,215,255))
    $g.FillEllipse($brush,1,1,$w-2,$h-2)
    $brush.Dispose()
    # Anti-aliased border to hide SetWindowRgn jagged edge
    $pen=New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180,200,230),1.5)
    $g.DrawEllipse($pen,1.5,1.5,$w-3,$h-3)
    $pen.Dispose()
    $whaleFont=New-Object System.Drawing.Font("Segoe UI Emoji",20)
    # Ball: only show colored whale icon
    $dsBlue=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26,86,219))
    $g.DrawString([char]::ConvertFromUtf32(0x1F40B),$whaleFont,$dsBlue,[float]($w/2-16),$w/2-14)
    $dsBlue.Dispose()
    $whaleFont.Dispose()
  }else{
    # Full mode
    $brush=New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      (New-Object System.Drawing.Point(0,0)),(New-Object System.Drawing.Point($w,$h)),
      [System.Drawing.Color]::FromArgb(240,248,255),[System.Drawing.Color]::FromArgb(200,225,255))
    $g.FillRectangle($brush,0,0,$w,$h)
    $brush.Dispose()

    $inAnim=($tag.anim -ne $null)
    # Whale - smaller during animation
    $wSize=if($inAnim){[int](28*$h/190)}else{28}
    $wY=if($inAnim){[int](10*$h/190)}else{10}
    $whaleFont=New-Object System.Drawing.Font("Segoe UI Emoji",[Math]::Max(10,$wSize))
    $dsBlue2=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26,86,219))
    $g.DrawString([char]::ConvertFromUtf32(0x1F40B),$whaleFont,$dsBlue2,[float]($w/2-$wSize/2-2),$wY)
    $dsBlue2.Dispose()
    $whaleFont.Dispose()

    if($inAnim){
      # Animation: only whale + balance, skip complex content
      $aSize=if($h -lt 120){11}else{15}
      $aY=if($h -lt 120){[int]($h/2+4)}else{54}
      $bfAnim=New-Object System.Drawing.Font("Segoe UI",$aSize,[System.Drawing.FontStyle]::Bold)
      $amtAnim="RMB $([math]::Round($balance.total,2))"
      $szAnim=$g.MeasureString($amtAnim,$bfAnim)
      $g.DrawString($amtAnim,$bfAnim,[System.Drawing.Brushes]::Black,[float](($w-$szAnim.Width)/2),$aY)
      $bfAnim.Dispose()
    }elseif($balance.error){
      $ef=New-Object System.Drawing.Font("Segoe UI",9)
      $g.DrawString($balance.error,$ef,[System.Drawing.Brushes]::Gray,10,60)
      $ef.Dispose()
    }else{
      $bf=New-Object System.Drawing.Font("Segoe UI",15,[System.Drawing.FontStyle]::Bold)
      $amt="RMB $([math]::Round($balance.total,2))"
      $sz=$g.MeasureString($amt,$bf)
      $bb=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30,64,175))
      $g.DrawString($amt,$bf,$bb,[float](($w-$sz.Width)/2),54)
      $bb.Dispose();$bf.Dispose()

      $bx=20;$by=95;$bw=$w-40;$bh=4;$gap=2
      $segW=[int](($bw-$gap*2)/3)
      $gray=[System.Drawing.Color]::FromArgb(210,210,210)
      $green=[System.Drawing.Color]::FromArgb(34,197,94)
      $yellow=[System.Drawing.Color]::FromArgb(251,191,36)
      $red=[System.Drawing.Color]::FromArgb(239,68,68)
      if($balance.pct -ge 20){$c1=$green;$c2=$green;$c3=$green}
      elseif($balance.pct -ge 10){$c1=$green;$c2=$yellow;$c3=$gray}
      else{$c1=$red;$c2=$gray;$c3=$gray}
      $b1=New-Object System.Drawing.SolidBrush($c1)
      $b2=New-Object System.Drawing.SolidBrush($c2)
      $b3=New-Object System.Drawing.SolidBrush($c3)
      $g.FillRectangle($b1,$bx,$by,$segW,$bh)
      $g.FillRectangle($b2,$bx+$segW+$gap,$by,$segW,$bh)
      $g.FillRectangle($b3,$bx+($segW+$gap)*2,$by,$segW,$bh)
      $b1.Dispose();$b2.Dispose();$b3.Dispose()
      $sf=New-Object System.Drawing.Font("Segoe UI",6)
      $g.DrawString(">20%",$sf,[System.Drawing.Brushes]::LightGray,$bx+2,$by+6)
      $g.DrawString(">10%",$sf,[System.Drawing.Brushes]::LightGray,$bx+$segW+$gap+2,$by+6)
      $g.DrawString("<10%",$sf,[System.Drawing.Brushes]::LightGray,$bx+($segW+$gap)*2+2,$by+6)
      $sf.Dispose()

      $st=if($balance.available){'Online'}else{'Exhausted'}
      $dc=if($balance.available){$green}else{$red}
      $stf=New-Object System.Drawing.Font("Segoe UI",8)
      $stb=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(50,50,50))
      $db=New-Object System.Drawing.SolidBrush($dc)
      $g.FillEllipse($db,$bx,$by-12,5,5)
      $g.DrawString($st,$stf,$stb,$bx+10,$by-17)
      $db.Dispose();$stb.Dispose();$stf.Dispose()

      $df=New-Object System.Drawing.Font("Segoe UI",8.5)
      $dtb=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60,60,60))
      $details="Recharged: $([math]::Round($balance.topped,2))    Grant: $([math]::Round($balance.granted,2))"
      $dsz=$g.MeasureString($details,$df)
      $g.DrawString($details,$df,$dtb,[float](($w-$dsz.Width)/2),125)
      $dtb.Dispose();$df.Dispose()
    }
  }
})

# ── Animation engine ──
$f.Tag=@{anim=$null;ball=$false;dockedEdge='';sx=0;sy=0}
$ANIM_STEPS=14
$ANIM_TICK=14

function Lerp($a,$b,$t){[int]($a+($b-$a)*$t)}

function StartAnim($toBall,$toX,$toY,$toW,$toH,$edge){
  $tag=$f.Tag
  if($tag.anim){return}
  $tag.anim=@{
    step=0;steps=$ANIM_STEPS
    fx=[int]$f.Left;fy=[int]$f.Top;fw=[int]$f.Width;fh=[int]$f.Height
    tx=$toX;ty=$toY;tw=$toW;th=$toH
    toBall=$toBall
  }
  $tag.dockedEdge=$edge
  $animTimer.Start()
}

function EndAnim{
  $tag=$f.Tag
  if($tag.anim){
    $a=$tag.anim
    $f.Size=New-Object System.Drawing.Size($a.tw,$a.th)
    $f.Location=New-Object System.Drawing.Point($a.tx,$a.ty)
    $tag.ball=$a.toBall
    SetShape $a.tw $a.th $a.toBall
    $tag.anim=$null
    $f.Invalidate()  # force full redraw with complete content
  }
  $animTimer.Stop()
}

$animTimer=New-Object System.Windows.Forms.Timer
$animTimer.Interval=$ANIM_TICK
$animTimer.Add_Tick({
  $tag=$f.Tag
  $a=$tag.anim
  if(-not $a){$animTimer.Stop();return}
  $a.step++
  # ease-in-out: accelerate then decelerate
  $p=$a.step/$a.steps
  if($p -lt 0.5){$t=2*$p*$p}else{$t=1-[Math]::Pow(-2*$p+2,2)/2}
  $nx=Lerp $a.fx $a.tx $t
  $ny=Lerp $a.fy $a.ty $t
  $nw=Lerp $a.fw $a.tw $t
  $nh=Lerp $a.fh $a.th $t
  $f.Size=New-Object System.Drawing.Size($nw,$nh)
  $f.Location=New-Object System.Drawing.Point($nx,$ny)
  # Only update window shape 3 times (start/mid/end) to reduce GDI overhead
  if($a.step -eq 1 -or $a.step -eq ([int]($a.steps/2)) -or $a.step -ge $a.steps){
    SetShape $nw $nh $a.toBall
  }
  if($a.step -ge $a.steps){EndAnim}
})

# ── Drag + Dock ──
$f.Add_MouseDown({
  $tag=$this.Tag
  if($tag.anim){return}
  if($tag.ball){
    # Exhale: animate from ball to full, safe distance from edges
    $scr=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $cx=[int]($this.Left+$this.Width/2)
    $cy=[int]($this.Top+$this.Height/2)
    $tx=[Math]::Max($scr.Left+60,[Math]::Min($scr.Right-$FULL_W-60,$cx-$FULL_W/2))
    $ty=[Math]::Max($scr.Top+60,[Math]::Min($scr.Bottom-$FULL_H-60,$cy-$FULL_H/2))
    StartAnim $false $tx $ty $FULL_W $FULL_H ''
  }else{
    [Dwm]::ReleaseCapture()|Out-Null
    [Dwm]::SendMessage($this.Handle,[Dwm]::WM_NCLBUTTONDOWN,[IntPtr][Dwm]::HT_CAPTION,[IntPtr]::Zero)|Out-Null
  }
})

# Edge snap timer
$snapTimer=New-Object System.Windows.Forms.Timer
$snapTimer.Interval=350
$snapTimer.Add_Tick({
  $tag=$f.Tag
  if($tag.anim -or $tag.ball){return}
  $scr=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x=[int]$f.Left;$y=[int]$f.Top;$w=[int]$f.Width;$h=[int]$f.Height
  $L=[int]$scr.Left;$T=[int]$scr.Top;$R=[int]$scr.Right;$B=[int]$scr.Bottom
  $M=25

  if($x+$w -gt $R-$M){
    $tag.sx=[Math]::Min($R-$w-80,$x);$tag.sy=$y
    $bx=$R-$BALL_R+10;$by=$y+[int](($h-$BALL_R)/2)
    StartAnim $true $bx $by $BALL_R $BALL_R 'right'
  }elseif($x -lt $L+$M){
    $tag.sx=[Math]::Max($L+80,$x);$tag.sy=$y
    $bx=$L-10;$by=$y+[int](($h-$BALL_R)/2)
    StartAnim $true $bx $by $BALL_R $BALL_R 'left'
  }elseif($y+$h -gt $B-$M){
    $tag.sx=$x;$tag.sy=[Math]::Min($B-$h-80,$y)
    $bx=$x+[int](($w-$BALL_R)/2);$by=$B-$BALL_R+10
    StartAnim $true $bx $by $BALL_R $BALL_R 'bottom'
  }elseif($y -lt $T+$M){
    $tag.sx=$x;$tag.sy=[Math]::Max($T+80,$y)
    $bx=$x+[int](($w-$BALL_R)/2);$by=$T-10
    StartAnim $true $bx $by $BALL_R $BALL_R 'top'
  }
})
$snapTimer.Start()

# ── Right-click ──
$ctx=New-Object System.Windows.Forms.ContextMenuStrip
$r1=New-Object System.Windows.Forms.ToolStripMenuItem("Refresh")
$r2=New-Object System.Windows.Forms.ToolStripMenuItem("Exit")
$ctx.Items.Add($r1);$ctx.Items.Add($r2)
$f.ContextMenuStrip=$ctx
$r1.Add_Click({Update})
$r2.Add_Click({$f.Close()})

# ── Balance update ──
function Update {
  try{
    $d=Invoke-RestMethod -Uri 'http://localhost:8765/api/balance' -Headers @{'x-api-key'=$KEY} -TimeoutSec 8
    if($d.error){throw $d.error}
    $b=$d.balance_infos[0]
    $script:balance.total=[float]$b.total_balance
    $script:balance.granted=[float]$b.granted_balance
    $script:balance.topped=[float]$b.topped_up_balance
    $orig=[Math]::Max($script:balance.granted+$script:balance.topped,0.01)
    $script:balance.pct=[Math]::Max(0,[Math]::Min(100,($script:balance.total/$orig)*100))
    $script:balance.available=$d.is_available
    $script:balance.error=''
  }catch{$script:balance.error="No connection"}
  $f.Invalidate()
}

$f.Add_Shown({
  Update
  $t=New-Object System.Windows.Forms.Timer
  $t.Interval=45000;$t.Add_Tick({Update});$t.Start()
})

[System.Windows.Forms.Application]::EnableVisualStyles()
$f.Show()
[System.Windows.Forms.Application]::Run($f)
