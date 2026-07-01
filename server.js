require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const http = require('http');
const https = require('https');
const cron = require('node-cron');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ===== الإعدادات =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const LOOTLABS_API_KEY = process.env.LOOTLABS_API_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://m92-store.render.com';
const STRIPE_SECRET = process.env.STRIPE_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';

const bot = new Telegraf(BOT_TOKEN);

// ===== Firebase Initialization =====
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
        }),
        databaseURL: FIREBASE_DB_URL
    });
}
const db = admin.database();
const ADMINS = new Set([parseInt(process.env.ADMIN_ID) || 6044738221]);

// ===== اللغات المدعومة =====
const locales = {
    en: {
        welcome: "🛒 Welcome to M92 Store!\nPremium mods with monthly subscription.",
        subscribe: "📅 Subscribe Now",
        myapps: "📱 My Apps",
        status: "📊 Subscription Status",
        renew: "🔄 Renew Subscription",
        free: "FREE",
        buy: "Buy Now 💳",
        download: "Download 📥",
        subscribed: "✅ Active Subscription",
        expired: "❌ Subscription Expired",
        days_left: "Days left:",
        tier: "Tier:"
    },
    ar: {
        welcome: "🛒 مرحباً بك في متجر M92!\nتعديلات احترافية مع اشتراك شهري.",
        subscribe: "📅 اشترك الآن",
        myapps: "📱 تطبيقاتي",
        status: "📊 حالة الاشتراك",
        renew: "🔄 تجديد الاشتراك",
        free: "مجاناً",
        buy: "شراء الآن 💳",
        download: "تحميل 📥",
        subscribed: "✅ الاشتراك فعال",
        expired: "❌ انتهى الاشتراك",
        days_left: "الأيام المتبقية:",
        tier: "المستوى:"
    }
};

// ===== نظام الاشتراكات (Tiers) =====
const TIERS = {
    free: { name: 'Free', price: 0, apps_limit: 1, duration_days: 1, description: 'Lootlabs 24h' },
    basic: { name: 'Basic', price: 2.99, apps_limit: 5, duration_days: 30, description: 'Premium Access 30 days' },
    premium: { name: 'Premium', price: 5.99, apps_limit: 999, duration_days: 30, description: 'Unlimited 30 days' }
};

// ===== دوال مساعدة =====

async function getUserLang(userId) {
    const user = await db.ref(`users/${userId}`).once('value');
    return (user.val()?.lang) || 'en';
}

async function createSubscription(userId, tier, transactionId = null) {
    const now = moment();
    const expiresAt = now.clone().add(TIERS[tier].duration_days, 'days').toDate().getTime();
    
    await db.ref(`subscriptions/${userId}`).set({
        userId,
        tier,
        purchase_date: now.toDate().getTime(),
        expires_at: expiresAt,
        active: true,
        last_renewal: now.toDate().getTime(),
        auto_renew: true,
        transaction_id: transactionId || uuidv4()
    });

    // أضف لـ expiry queue للتحقق التلقائي
    await db.ref(`expiry_queue/${userId}`).set({
        userId,
        expires_at: expiresAt,
        tier,
        notification_sent: false
    });

    return expiresAt;
}

async function checkSubscriptionExpiry() {
    const now = Date.now();
    const expiredUsers = await db.ref('expiry_queue').once('value');

    expiredUsers.forEach(async (snapshot) => {
        const data = snapshot.val();
        if (data.expires_at <= now && !data.notification_sent) {
            // الاشتراك انتهى - أرسل تنبيه
            try {
                await bot.telegram.sendMessage(snapshot.key, 
                    `⏰ اشتراكك انتهى!\nاكتب /renew للتجديد أو /subscribe لخيارات جديدة`
                );
            } catch (e) { console.log('User not available for notification'); }

            // وضّع الفلاج
            await db.ref(`expiry_queue/${snapshot.key}`).update({ notification_sent: true });
            
            // عطّل الوصول
            await db.ref(`subscriptions/${snapshot.key}`).update({ active: false });
        }
    });
}

async function getUserAppsList(userId, tier) {
    const apps = await db.ref('products').once('value');
    const userApps = [];
    
    apps.forEach(app => {
        const product = app.val();
        // تحقق: هل المستخدم له صلاحية لهذا التطبيق؟
        if (product.min_tier_required === undefined || isAllowedTier(tier, product.min_tier_required)) {
            userApps.push(product);
        }
    });

    return userApps.slice(0, TIERS[tier].apps_limit);
}

function isAllowedTier(userTier, requiredTier) {
    const tierOrder = { 'free': 0, 'basic': 1, 'premium': 2 };
    return tierOrder[userTier] >= tierOrder[requiredTier];
}

// ===== أوامر البوت =====

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    let lang = ctx.from.language_code ? ctx.from.language_code.substring(0, 2) : 'en';
    if (!['en', 'ar'].includes(lang)) lang = 'en';

    await db.ref(`users/${userId}`).update({
        id: userId,
        username: ctx.from.username || 'unknown',
        lang: lang,
        first_seen: new Date().getTime()
    });

    ctx.reply(locales[lang].welcome, Markup.inlineKeyboard([
        [Markup.button.webApp('🌐 ' + locales[lang].subscribe, `${WEBAPP_URL}/store?lang=${lang}&action=subscribe`)],
        [Markup.button.callback(locales[lang].myapps, 'myapps'), Markup.button.callback(locales[lang].status, 'status')]
    ]));
});

bot.command('subscribe', async (ctx) => {
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);

    const tierButtons = [
        [Markup.button.callback(`🆓 ${TIERS.free.name} (${locales[lang].free})`, 'tier_free')],
        [Markup.button.callback(`💳 ${TIERS.basic.name} ($${TIERS.basic.price})`, 'tier_basic')],
        [Markup.button.callback(`⭐ ${TIERS.premium.name} ($${TIERS.premium.price})`, 'tier_premium')]
    ];

    ctx.reply(`${lang === 'ar' ? 'اختر خطتك:' : 'Choose your plan:'}`, Markup.inlineKeyboard(tierButtons));
});

bot.action(/^tier_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const tier = ctx.match[1];
    const lang = await getUserLang(userId);
    const price = TIERS[tier].price;

    if (price === 0) {
        // مجاني - استخدم Lootlabs
        await createSubscription(userId, 'free');
        ctx.reply(`✅ ${locales[lang].subscribed}\n${locales[lang].tier} ${TIERS.free.name}`);
    } else {
        // مدفوع - أنشئ رابط دفع
        const paymentLink = await generatePaymentLink(userId, tier);
        ctx.reply(
            `💳 ${lang === 'ar' ? 'اضغط على الزر للدفع' : 'Click below to pay'}\n${TIERS[tier].description}`,
            Markup.inlineKeyboard([[Markup.button.url(`💳 Pay $${price}`, paymentLink)]])
        );
    }
});

bot.action('myapps', async (ctx) => {
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);
    const subscription = await db.ref(`subscriptions/${userId}`).once('value');

    if (!subscription.exists() || !subscription.val().active) {
        return ctx.reply(locales[lang].expired);
    }

    const tier = subscription.val().tier;
    const apps = await getUserAppsList(userId, tier);

    if (apps.length === 0) {
        return ctx.reply(lang === 'ar' ? 'لا توجد تطبيقات متاحة' : 'No apps available');
    }

    const appButtons = apps.map(app => [
        Markup.button.callback(app.name, `download_${app.id}`)
    ]);

    ctx.reply(lang === 'ar' ? 'اختر تطبيقاً:' : 'Select an app:', Markup.inlineKeyboard(appButtons));
});

bot.action(/^download_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const appId = ctx.match[1];
    const lang = await getUserLang(userId);

    const app = await db.ref(`products/${appId}`).once('value');
    if (!app.exists()) {
        return ctx.reply(lang === 'ar' ? 'التطبيق غير متوفر' : 'App not found');
    }

    const appData = app.val();
    
    // تحقق من الاشتراك
    const subscription = await db.ref(`subscriptions/${userId}`).once('value');
    if (!subscription.exists() || !subscription.val().active) {
        return ctx.reply(locales[lang].expired);
    }

    // إذا كان file_id موجود - أرسل الملف مباشرة من Telegram
    if (appData.apk_file_id) {
        try {
            await bot.telegram.sendDocument(userId, appData.apk_file_id, {
                caption: `📱 ${appData.name}\n✅ ${locales[lang].subscribed}`
            });
            
            // سجّل الوصول
            await db.ref(`access_log/${userId}/${appId}`).set({
                timestamp: new Date().getTime(),
                tier: subscription.val().tier
            });
        } catch (e) {
            ctx.reply(lang === 'ar' ? 'خطأ في التحميل' : 'Download error');
        }
    } else {
        ctx.reply(lang === 'ar' ? 'الملف غير متوفر حالياً' : 'File unavailable');
    }
});

bot.action('status', async (ctx) => {
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);
    const subscription = await db.ref(`subscriptions/${userId}`).once('value');

    if (!subscription.exists()) {
        return ctx.reply(locales[lang].expired);
    }

    const sub = subscription.val();
    const expiresAt = moment(sub.expires_at);
    const daysLeft = expiresAt.diff(moment(), 'days');

    const status = `
${sub.active ? locales[lang].subscribed : locales[lang].expired}
${locales[lang].tier} ${TIERS[sub.tier].name} ($${TIERS[sub.tier].price})
${locales[lang].days_left} ${daysLeft} يوم

${lang === 'ar' ? 'تاريخ الانتهاء: ' : 'Expires: '} ${expiresAt.format('YYYY-MM-DD')}
    `;

    ctx.reply(status.trim(), Markup.inlineKeyboard([
        [Markup.button.callback(locales[lang].renew, 'renew_sub')]
    ]));
});

bot.action('renew_sub', async (ctx) => {
    // نفس عملية /subscribe
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);
    const tierButtons = [
        [Markup.button.callback(`💳 ${TIERS.basic.name} ($${TIERS.basic.price})`, 'tier_basic')],
        [Markup.button.callback(`⭐ ${TIERS.premium.name} ($${TIERS.premium.price})`, 'tier_premium')]
    ];
    ctx.reply(lang === 'ar' ? 'اختر خطتك:' : 'Choose your plan:', Markup.inlineKeyboard(tierButtons));
});

// ===== أوامر المسؤولين =====

bot.command('addproduct', async (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return ctx.reply('⚠️ Admins only');
    
    const args = ctx.payload.split('|').map(item => item.trim());
    if (args.length < 3) {
        return ctx.reply('Usage: /addproduct Name | Price | MinTier\nMinTier: free, basic, or premium');
    }

    const [name, priceStr, minTier] = args;
    const price = parseFloat(priceStr) || 0;
    const productId = `prod_${Date.now()}`;

    await db.ref(`products/${productId}`).set({
        id: productId,
        name: name,
        price: price,
        min_tier_required: minTier,
        created_at: new Date().getTime(),
        image_url: '',
        apk_file_id: ''
    });

    await db.ref(`admin_session/${ctx.from.id}`).set({ active_product_id: productId });
    ctx.reply(`✅ Product "${name}" created!\n📸 Send the app icon next.`);
});

bot.on('photo', async (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return;
    
    const session = await db.ref(`admin_session/${ctx.from.id}`).once('value');
    if (!session.exists()) return ctx.reply('No active product. Use /addproduct first.');

    const productId = session.val().active_product_id;
    const photo = ctx.message.photo.pop();
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);

    await db.ref(`products/${productId}`).update({ image_url: fileLink.href });
    ctx.reply('📸 Icon saved!\n📦 Now forward the .apk file.');
});

bot.on('document', async (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return;

    const session = await db.ref(`admin_session/${ctx.from.id}`).once('value');
    if (!session.exists()) return ctx.reply('No active product.');

    const productId = session.val().active_product_id;
    const doc = ctx.message.document;

    if (doc.file_name.endsWith('.apk')) {
        await db.ref(`products/${productId}`).update({ apk_file_id: doc.file_id });
        ctx.reply('🚀 Product uploaded successfully to M92 Store!');
        await db.ref(`admin_session/${ctx.from.id}`).remove();
    } else {
        ctx.reply('❌ Only .apk files accepted');
    }
});

// ===== دوال الدفع =====

async function generatePaymentLink(userId, tier) {
    const price = TIERS[tier].price;
    const orderId = `order_${userId}_${Date.now()}`;
    
    // حفظ طلب الدفع
    await db.ref(`pending_orders/${orderId}`).set({
        userId,
        tier,
        amount: price,
        created_at: new Date().getTime(),
        status: 'pending'
    });

    // رابط Stripe/PayPal (مثال - عدّل حسب احتياجاتك)
    if (STRIPE_SECRET) {
        // TODO: أنشئ Stripe session
        return `https://buy.stripe.com/example`;
    }
    
    // أو استخدم رابط مجموعة مخصصة
    return `${WEBAPP_URL}/pay?order=${orderId}&tier=${tier}&amount=${price}`;
}

// ===== Web Server =====

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.url.startsWith('/store')) {
        res.writeHead(200);
        res.end(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>M92 Store</title>
    <style>
        body { background: #0f0f1e; color: #fff; font-family: system-ui; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
        .card { background: #1a1a2e; border: 1px solid #16f4d0; border-radius: 12px; padding: 15px; cursor: pointer; transition: 0.3s; }
        .card:hover { transform: translateY(-5px); border-color: #fff; }
        .card img { width: 100%; aspect-ratio: 1; border-radius: 8px; background: #2a2a3e; }
        .card-title { font-weight: bold; margin: 10px 0; font-size: 14px; }
        .card-price { color: #16f4d0; font-weight: bold; }
        .btn { background: #16f4d0; color: #000; padding: 10px; border: none; border-radius: 8px; width: 100%; margin-top: 10px; font-weight: bold; cursor: pointer; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🛒 M92 STORE</h1>
        <p>Premium Mobile Modifications</p>
    </div>
    <div class="grid" id="products"></div>
    <script>
        const params = new URLSearchParams(location.search);
        const lang = params.get('lang') || 'en';
        // اتصل بـ Firebase وحمّل التطبيقات
        document.getElementById('products').innerHTML = '<p>Loading...</p>';
    </script>
</body>
</html>
        `);
    } else {
        res.writeHead(200);
        res.end('M92 Store Running ✅');
    }
});

// ===== Scheduled Tasks =====

// تحقق من الاشتراكات المنتهية كل ساعة
cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Checking expired subscriptions...');
    await checkSubscriptionExpiry();
});

// تنظيف البيانات القديمة كل يوم
cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Cleaning old data...');
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const oldOrders = await db.ref('pending_orders').orderByChild('created_at').endAt(sevenDaysAgo).once('value');
    oldOrders.forEach(order => {
        if (order.val().status === 'pending') order.ref.remove();
    });
});

// ===== تشغيل البوت والسيرفر =====

bot.launch().then(() => console.log('✅ Bot Active')).catch(err => console.error('Bot Error:', err));
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    bot.stop();
    server.close();
    process.exit(0);
});
