# הפעלת התחברות עם Google ו‑GitHub

**כל הקוד כבר מחובר.** הפרונט כולל: שני כפתורים בהדר (**הרשמה** / **התחברות**),
חלונית עם **המשך עם Google** ו**המשך עם GitHub**, זרימת OAuth מלאה דרך Supabase,
שמירת session, ומצב "מחובר" בהדר (שם המשתמש + כפתור התנתקות).

נשאר רק דבר אחד שאני לא יכול לעשות במקומך כי הוא דורש את החשבונות שלך:
**ליצור פרויקט Supabase + לרשום אפליקציות OAuth**. זה ~5–10 דקות, והכל למטה.

---

## שלב 1 — פרויקט Supabase (2 דקות)

1. נכנסים ל‑[supabase.com](https://supabase.com) → **New project** (חינמי).
2. אחרי שנוצר: **Project Settings → API**. מעתיקים שני ערכים:
   - **Project URL** (למשל `https://abcdxyz.supabase.co`)
   - **anon public key** (המפתח הציבורי — מיועד לדפדפן, בטוח לשים בקוד)

## שלב 2 — מדביקים את שני הערכים בקוד

פותחים את [`js/main.js`](js/main.js), מוצאים בראש בלוק ה‑auth את השורות האלה
ומדביקים בתוכן:

```js
var SUPABASE_URL = "";        // ← Project URL
var SUPABASE_ANON_KEY = "";   // ← anon public key
```

*(רק את שתי השורות האלה. שום דבר אחר בקובץ לא צריך להשתנות.)*

## שלב 3 — רושמים אפליקציית Google

1. [Google Cloud Console](https://console.cloud.google.com) → פרויקט חדש.
2. **APIs & Services → OAuth consent screen** → שם אפליקציה + אימייל.
3. **Credentials → Create Credentials → OAuth client ID → Web application**.
4. תחת **Authorized redirect URIs** מדביקים בדיוק:
   ```
   https://YOUR-PROJECT.supabase.co/auth/v1/callback
   ```
   (מחליפים `YOUR-PROJECT` ב‑URL שלכם משלב 1)
5. מעתיקים **Client ID** + **Client Secret**.
6. ב‑Supabase → **Authentication → Providers → Google** → מפעילים ומדביקים את השניים.

## שלב 4 — רושמים אפליקציית GitHub

1. [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**.
2. **Homepage URL**: `https://mihutz-latavnit.vercel.app`
3. **Authorization callback URL** — בדיוק:
   ```
   https://YOUR-PROJECT.supabase.co/auth/v1/callback
   ```
4. מעתיקים **Client ID**, מייצרים **Client Secret**.
5. ב‑Supabase → **Authentication → Providers → GitHub** → מפעילים ומדביקים את השניים.

## שלב 5 — מגדירים כתובות חזרה ב‑Supabase

ב‑Supabase → **Authentication → URL Configuration → Redirect URLs**, מוסיפים:
```
https://mihutz-latavnit.vercel.app/**
http://localhost:5500/**
```
(השני מאפשר לבדוק מקומית עם השרת שאנחנו מריצים.)

---

## זהו — עכשיו זה עובד

אחרי שמירת הקובץ ופריסה מחדש (או הרצה מקומית), לחיצה על **הרשמה** או **התחברות**
פותחת את החלונית, ולחיצה על Google/GitHub מבצעת התחברות אמיתית. אחרי החזרה לאתר
ההדר יציג את שם המשתמש וכפתור **התנתקות**. כל מי שנרשם נשמר תחת
**Authentication → Users** בלוח של Supabase.

> **אבטחה:** ה‑Client Secret של Google ו‑GitHub נשמר רק אצל Supabase — לעולם לא
> ב‑HTML/JS ולא ב‑git. ה‑anon key שבקוד הוא ציבורי בכוונה ומיועד לדפדפן.
