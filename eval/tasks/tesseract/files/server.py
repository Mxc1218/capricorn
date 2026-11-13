import os, re, tempfile, qrcode, cv2, pyzbar.pyzbar, zxing, zxingcpp, PIL

def scan(flag):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.png', delete=False) as f:
        QR = qrcode.QRCode()
        QR.add_data(flag)
        QR.make_image().save(filename := f.name)
        flags = set([
            cv2.QRCodeDetector().detectAndDecode(cv2.imread(filename))[0],
            pyzbar.pyzbar.decode(PIL.Image.open(filename))[0].data.decode(),
            zxing.BarCodeReader().decode(filename).parsed,
            zxingcpp.read_barcodes(PIL.Image.open(filename))[0].text
        ])
        os.unlink(filename)
    return flags

try:
    assert scan("alictf{sanity_check}") == {"alictf{sanity_check}"}
    
    flag = input('🚩 ').strip()
    assert re.fullmatch(r'alictf\{[\x20-\x7a]+\}', flag)
    
    username = input('👥 ').strip()
    targets = set(["阿里夺旗赛", "ALICTF", "🐱🚩🎉", f"Hacked by {username}"])
    
    dimension = len(scan(flag) & targets)
    print(f"{dimension = }")
    if dimension == 4:
        print('✨', os.getenv("FLAG"))
except:
    exit()
