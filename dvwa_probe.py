import urllib.request, urllib.parse, http.cookiejar, re, sys

BASE = "http://127.0.0.1:8080/DVWA-master/"
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
op.addheaders = [('User-Agent','Mozilla/5.0'), ('Referer', BASE+'login.php')]

def get(url):
    r = op.open(url, timeout=15)
    return r.getcode(), r.read().decode('utf-8', 'replace'), r.geturl()

def post(url, data):
    d = urllib.parse.urlencode(data).encode()
    r = op.open(urllib.request.Request(url, data=d), timeout=15)
    return r.getcode(), r.read().decode('utf-8','replace'), r.geturl()

# 1. get login page + token
code, body, _ = get(BASE + "login.php")
m = re.search(r"name='user_token' value='([0-9a-f]+)'", body)
token = m.group(1) if m else ""
print("[1] login.php status=%s token=%s" % (code, token))
print("    cookies after GET:", [(c.name, c.value) for c in cj])

# 2. login
code, body, url = post(BASE + "login.php", {
    "username":"admin", "password":"password",
    "Login":"Login", "user_token":token})
print("[2] login POST status=%s final_url=%s" % (code, url))
print("    cookies:", [(c.name, c.value) for c in cj])
print("    Login failed msg present:", "Login failed" in body or "login failed" in body.lower())
m = re.search(r"Welcome to Damn Vulnerable Web Application|You have logged in", body)
print("    logged-in marker:", bool(m))

# 3. index.php
code, body, url = get(BASE + "index.php")
print("[3] index.php status=%s url=%s len=%d" % (code, url, len(body)))
m = re.search(r"<em>([^<]*)</em>", body)
print("    index title line:", m.group(1) if m else "?")
sec = [ (c.name,c.value) for c in cj if c.name=='security']
print("    security cookie now:", sec)

open("index_after_login.html","w",encoding="utf-8").write(body)

# 4. security page
code, body, url = get(BASE + "security.php")
print("[4] security.php status=%s url=%s len=%d" % (code, url, len(body)))
m = re.findall(r"<option value=\"(\w+)\"([^>]*)>([^<]*)</option>", body)
print("    options:", m)
m = re.search(r"name='user_token' value='([0-9a-f]+)'", body)
token2 = m.group(1) if m else ""
print("    security token:", token2)

# 5. set security = low
code, body, url = post(BASE + "security.php", {
    "security":"low", "seclev_submit":"Submit", "user_token":token2})
print("[5] set low status=%s url=%s" % (code, url))
print("    cookies:", [(c.name, c.value) for c in cj])
open("security_low.html","w",encoding="utf-8").write(body)

# verify
code, body, url = get(BASE + "security.php")
m = re.search(r'<option value="(\w+)" selected', body)
print("[6] security.php selected now:", m.group(1) if m else "?")
print("    security cookie:", [(c.name,c.value) for c in cj if c.name=='security'])

# 6. probe modules
mods = ["vulnerabilities/exec/", "vulnerabilities/fi/", "vulnerabilities/upload/",
        "vulnerabilities/sqli/", "vulnerabilities/sqli_blind/", "vulnerabilities/xss_r/",
        "vulnerabilities/xss_s/", "vulnerabilities/csrf/", "vulnerabilities/brute/",
        "vulnerabilities/weak_id/", "vulnerabilities/javascript/", "vulnerabilities/open_redirect/",
        "vulnerabilities/csp/", "vulnerabilities/authbypass/", "vulnerabilities/sqli_union/"]
for mod in mods:
    try:
        code, body, url = get(BASE + mod)
        t = re.search(r"<title>([^<]*)</title>", body)
        ok = code==200 and "login.php" not in url
        print("[mod] %-32s status=%s ok=%s title=%s len=%d" % (mod, code, ok, t.group(1) if t else "?", len(body)))
    except Exception as e:
        print("[mod] %-32s ERROR %s" % (mod, e))
