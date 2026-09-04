# شروع کن — فقط این فایل

هر بلوک را کپی کن، بزن، برو بعدی. توضیح نمی‌دهم؛ اگر خواستی بدانی چرا، `docs/GO-LIVE-fa.md`.

---

## گام ۰ — دو رشته از سوپابیس بردار (۲ دقیقه، در مرورگر)

برو: **Supabase → پروژه‌ات → Project Settings → Database → Connection string**

دو تا را کپی کن و یک جا نگه دار (Notepad):

| در دشبورد پیدا کن | اسمش پیش خودت |
|---|---|
| **Transaction pooler** — پورت `6543` | رشتهٔ **الف** |
| **Session pooler** — پورت `5432` | رشتهٔ **ب** |

جای `[YOUR-PASSWORD]` در هر دو، رمز دیتابیس را بگذار. یادت نیست؟ همان صفحه → `Reset database password`.

> ⚠️ سراغ **Direct connection** نرو. روی سرورت کار نمی‌کند.

---

## گام ۱ — وصل شو به سرور

```
ssh -i ~/.ssh/retrocode_server root@45.129.126.98
```

**از این به بعد همه‌چیز داخل سرور تایپ می‌شود.**

---

## گام ۲ — کد را بگیر

```bash
cd /opt/avex 2>/dev/null || git clone https://github.com/masonaescjcj-oss/avex.git /opt/avex
cd /opt/avex
git fetch origin claude/avex-pay-setup-cnlasi
git checkout -B claude/avex-pay-setup-cnlasi origin/claude/avex-pay-setup-cnlasi
NODE_OPTIONS=--max-old-space-size=700 npm ci --include=dev
```

> این چند دقیقه طول می‌کشد. آن `NODE_OPTIONS` لازم است — سرورت ۲ گیگ رم دارد و سه اپ دیگر
> رویش زنده است؛ بدون سقف، ممکن است کرنل یکی از آن‌ها را بکشد.

---

## گام ۳ — تست اتصال دیتابیس

```bash
bash deploy/install.sh --check-db
```

دو سؤال می‌پرسد. رشتهٔ **الف** را بده، بعد رشتهٔ **ب**. (تایپ دیده نمی‌شود، طبیعی است.)

باید آخرش این را ببینی:

```
both strings work.
```

**اگر نه:** خروجی را برای من بفرست و همین‌جا بایست.

---

## گام ۴ — تست خود اسکریپت

```bash
bash deploy/install.sh --selftest
```

باید آخرش این را ببینی:

```
everything the script generates is well-formed.
```

**اگر نه:** خروجی را بفرست و بایست.

---

## گام ۵ — نصب

```bash
sudo bash deploy/install.sh
```

سؤال‌هایش را به این ترتیب می‌پرسد. **جواب‌ها:**

| می‌پرسد | تو بزن |
|---|---|
| `DATABASE_URL` | رشتهٔ **الف** |
| `DIRECT_DATABASE_URL` | رشتهٔ **ب** |
| `SMTP_URL` | اگر داری، بده. نداری؟ `smtps://user:pass@smtp.example.net:465` بزن و بعداً درستش کن |
| `MAIL_FROM` | Enter |
| `OPERATOR_EMAIL` | ایمیل خودت |
| `The public domain of the static pages` | Enter |
| `TRON JSON-RPC endpoint` | Enter |
| `Set up a settlement key now?` | **n** |
| `The hostname the API should answer on` | Enter |
| `Create the first admin account now?` | **y** |
| `email` / `name` / `password` | ایمیل خودت / اسمت / یک رمز **۱۴ کاراکتر یا بیشتر** |

بعد یک لینک `otpauth://...` چاپ می‌کند.

> 🔴 **همان لحظه** در Google Authenticator (یا Aegis) اسکن/ثبتش کن. **یک بار چاپ می‌شود.** اگر
> از دستش بدهی نمی‌شود واردِ پنل ادمین شد.

---

## گام ۶ — nginx و گواهی TLS

اسکریپت یک فایل آماده در `/etc/avex/nginx-api.conf` گذاشته (پورت ۸۰). نصبش:

```bash
ln -sf /etc/avex/nginx-api.conf /etc/nginx/conf.d/avex-api.conf
nginx -t && systemctl reload nginx
```

`nginx -t` باید `syntax is ok` بدهد. **اگر خطا داد، reload نکن** — لینک را پاک کن
(`rm /etc/nginx/conf.d/avex-api.conf`) و خروجی را بفرست.

بعد در پنل DNS دامنه‌ات: یک رکورد **A** برای `api` به IP `45.129.126.98`.

یک دقیقه صبر کن، بعد گواهی بگیر:

```bash
certbot --nginx -d api.avexpay.net
```

(اگر `certbot` نداری: `apt install -y certbot python3-certbot-nginx`)

certbot خودش پورت ۴۴۳ و مسیر گواهی را به همان فایل اضافه می‌کند. بعد:

```bash
curl -s https://api.avexpay.net/health
```

باید `{"status":"ok"}` بدهد.

---

> اسکریپت پورت آزاد پیدا می‌کند. چون ۳۰۰۰ تا ۳۰۰۲ روی سرورت گرفته‌اند، احتمالاً **۳۰۰۳**
> برمی‌دارد و همان را در فایل nginx می‌گذارد. اپ‌های خودت دست‌نخورده می‌مانند.

## گام ۷ — کار می‌کند؟

```bash
systemctl status avex-api avex-watcher --no-pager | head -20
```

هر دو باید `active (running)` باشند.

---

## تمام. بعد از این در مرورگر:

1. برو `https://avexpay.net/dashboard` → ثبت‌نام کن → ایمیلت را تأیید کن
2. داخل داشبورد: سه تا آدرس کیف پول **TRON** خودت را ثبت کن
3. یک فاکتور بساز، با کیف پول واقعی **همان مبلغ دقیق** را بفرست
4. تماشا کن: `journalctl -u avex-watcher -f`

اگر پرداخت دیده شد، **لایو هستی.**

---

## اگر هر جا گیر کردی

**یک دستور**، و خروجی‌اش را بفرست:

```bash
sudo bash /opt/avex/deploy/install.sh --report
```

می‌گوید چه کامیتی نصب است، سرویس‌ها زنده‌اند یا نه، دیتابیس با این بیلد جور است یا عقب
است (یا کلاً دیتابیس دیگری است)، و آخرین خطاهایی که API لاگ کرده. هیچ چیزی را عوض
نمی‌کند و خروجی‌اش رمز ندارد — می‌شود همان‌طور کپی کرد.

اگر آن دستور هنوز روی سرورت نیست، اول کد را بگیر:

```bash
cd /opt/avex && git fetch origin claude/avex-pay-setup-cnlasi &&
  git checkout -B claude/avex-pay-setup-cnlasi origin/claude/avex-pay-setup-cnlasi
```

## دستورهایی که بعداً لازم می‌شوند

```bash
# سوپابیس را عوض کردی؟
sudo bash deploy/install.sh --reconfigure

# کد جدید آمد؟
sudo bash deploy/install.sh

# چی الان واقعاً نصب و اجرا است؟ (چیزی را عوض نمی‌کند)
sudo bash deploy/install.sh --report

# لاگ زنده
journalctl -u avex-watcher -f
```
