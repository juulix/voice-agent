# 💾 Railway Volume Setup (Session Persistence)

## ⚠️ Problēma

Sessions tiek saglabātas uz `/tmp`, kas **nav persistents** Railway. Tas nozīmē:
- ❌ Sessions pazūd, kad serveris restartējas
- ❌ Sessions pazūd, kad Railway redeploy

## ✅ Risinājums: Railway Volume

### **Step 1: Izveidot Volume Railway Dashboard**

1. Atver Railway projektu: https://railway.app/
2. Iet uz **Settings** → **Volumes**
3. Click **"New Volume"**
4. Nosaukt: `smartchat-sessions`
5. Mount path: `/data` (vai cits path)

### **Step 2: Pievienot Environment Variable**

Railway Dashboard → **Variables**:
```
RAILWAY_VOLUME_MOUNT_PATH=/data
```

### **Step 3: Restart Server**

Railway automātiski restartē serveri pēc env var pievienošanas.

---

## 📊 Pārbaude

Pēc restart, logā redzēsi:
```
✅ Using Railway Volume: /data
💾 Backed up X sessions
```

**NEVIS:**
```
⚠️ WARNING: Using /tmp for session backup (NOT persistent!)
```

---

## 🔄 Alternatīva: Redis (Ilgtermiņā)

Ja vajag horizontal scaling (vairāki serveri):
1. Railway → **New** → **Redis**
2. Pievienot Redis add-on
3. Migrēt `session-manager.js` uz Redis

**Bet tagad Railway Volume ir pietiekami!** ✅
