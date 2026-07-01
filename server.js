const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const http = require('http');

// --- 1. الإعدادات والتوكنز المحمية ---
const BOT_TOKEN = process.env.BOT_TOKEN || '8739068450:AAHIcEFECoLgWs6sfV9KCCsc-bxWs8hKqtA';
const LOOTLABS_API_KEY = process.env.LOOTLABS_API_KEY || 'f540d2476d6156d459268adbdd95ec456a403db7eb91a3e05e129b9f84a86396';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://hshgaiw.onrender.com'; 

const bot = new Telegraf(BOT_TOKEN);

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}
const db = admin.database();
let ADMINS = new Set([6044738221]); 

const locales = {
    en: { welcome: "Welcome to M92 Store! 🛒\nExplore premium & free mods below:" },
    ar: { welcome: "مرحباً بك في متجر M92 Store! 🛒\nاستكشف التعديلات المجانية والمدفوعة أدناه:" },
    fr: { welcome: "Bienvenue sur M92 Store! 🛒\nDécouvrez les mods premium & gratuits ci-dessous:" },
    es: { welcome: "¡Bienvenido a M92 Store! 🛒\nExplora mods premium y gratuitos a continuación:" }
};

// --- 2. نظام البوت واختيار اللغات ---
bot.start(async (ctx) => {
    let lang = ctx.from.language_code ? ctx.from.language_code.substring(0, 2) : 'en';
    if (!['en', 'ar', 'fr', 'es'].includes(lang)) lang = 'en';
    await db.ref(`users/${ctx.from.id}`).update({ id: ctx.from.id, lang: lang });
    
    ctx.reply(locales[lang].welcome, Markup.keyboard([
        [Markup.button.webApp('🌐 M92 Store App', `${WEBAPP_URL}/store?lang=${lang}`)],
        ['🇺🇸 English', '🇸🇦 العربية'], ['🇫🇷 Français', '🇪🇸 Español']
    ]).resize());
});

bot.hears(['🇺🇸 English', '🇸🇦 العربية', '🇫🇷 Français', '🇪🇸 Español'], async (ctx) => {
    const langMap = { '🇺🇸 English': 'en', '🇸🇦 العربية': 'ar', '🇫🇷 Français': 'fr', '🇪🇸 Español': 'es' };
    const selectedLang = langMap[ctx.text];
    await db.ref(`users/${ctx.from.id}`).update({ lang: selectedLang });
    ctx.reply(locales[selectedLang].welcome);
});

// --- 3. لوحة تحكم الإدارة (Admins) ---
bot.command('addadmin', (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return;
    const newAdminId = parseInt(ctx.payload);
    if (newAdminId) { ADMINS.add(newAdminId); ctx.reply(`✅ Admin Added: ${newAdminId}`); }
});

bot.command('addproduct', async (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return ctx.reply("⚠️ Admins only.");
    const args = ctx.payload.split('|').map(item => item.trim());
    if (args.length < 4) return ctx.reply("❌ Formula: /addproduct Name | Price | Features | CustomLink");

    const [name, priceStr, featuresStr, customFirebaseLink] = args;
    const price = parseFloat(priceStr);
    const features = featuresStr.split(',').map(f => f.trim());
    let finalLink = customFirebaseLink;

    if (price === 0) {
        try {
            const response = await axios.post('https://api.lootlabs.gg/v1/links', {
                target_url: customFirebaseLink, title: `${name} - M92 Store`
            }, { headers: { 'Authorization': `Bearer ${LOOTLABS_API_KEY}` } });
            if (response.data && response.data.short_url) finalLink = response.data.short_url;
        } catch (err) { console.error("Lootlabs error, using direct link."); }
    }

    const productId = 'prod_' + Date.now();
    await db.ref(`products/${productId}`).set({
        id: productId, name: name, price: price, is_free: price === 0, features: features, link: finalLink, image_url: "", apk_file_id: ""
    });

    await db.ref(`admin_session/${ctx.from.id}`).set({ active_product_id: productId });
    ctx.reply(`✅ Registered *${name}* ($${price === 0 ? 'FREE' : price})!\n\n📸 Now send the app icon photo.`, { parse_mode: 'Markdown' });
});

bot.on('photo', async (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return;
    const session = await db.ref(`admin_session/${ctx.from.id}`).once('value');
    if (!session.exists()) return;
    const productId = session.val().active_product_id;
    const photo = ctx.message.photo.pop();
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    await db.ref(`products/${productId}`).update({ image_url: fileLink.href });
    ctx.reply("📸 Photo attached! 📦 Finally, forward or send the `.apk` file now.");
});

bot.on('document', async (ctx) => {
    if (!ADMINS.has(ctx.from.id)) return;
    const session = await db.ref(`admin_session/${ctx.from.id}`).once('value');
    if (!session.exists()) return;
    const productId = session.val().active_product_id;
    const doc = ctx.message.document;

    if (doc.file_name.endsWith('.apk')) {
        await db.ref(`products/${productId}`).update({ apk_file_id: doc.file_id });
        ctx.reply("🚀 Deployment Complete! Connected to M92 Store.");
        await db.ref(`admin_session/${ctx.from.id}`).remove();
    }
});

// --- 4. خادم الويب المصلح لبث الواجهة (WebApp) ---
const PORT = process.env.PORT || 3000;
bot.launch().then(() => console.log(`M92 Core Active`));

http.createServer((req, res) => {
    if (req.url.startsWith('/store')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>M92 Store</title>
    <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js"></script>
    <style>
        body { background-color: #0b0e14; color: #fff; font-family: system-ui, sans-serif; margin: 0; padding: 15px; }
        .header { text-align: center; padding: 15px 0; }
        .header h1 { margin: 0; font-size: 26px; font-weight: 800; color: #fff; }
        .header p { color: #6b7280; font-size: 13px; margin: 5px 0; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 15px; }
        .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 12px; display: flex; flex-direction: column; justify-content: space-between; }
        .card img { width: 100%; aspect-ratio: 1; border-radius: 12px; object-fit: cover; background: #1f2937; }
        .card .title { font-size: 14px; font-weight: 700; margin: 10px 0 4px 0; overflow: hidden; text-overflow: ellipsis; }
        .card .price { font-size: 15px; font-weight: 800; color: #3b82f6; }
        .card .price.free { color: #10b981; }
        .btn { width: 100%; background: #fff; color: #000; border: none; padding: 10px; border-radius: 10px; font-weight: 700; margin-top: 10px; cursor: pointer; }
    </style>
</head>
<body>
    <div class="header"><h1>M92 STORE</h1><p>Premium & Verified Mobile Modifications</p></div>
    <div class="grid" id="g"></div>
    <script>
        const config = { databaseURL: "${process.env.FIREBASE_DATABASE_URL}" };
        firebase.initializeApp(config);
        const urlParams = new URLSearchParams(window.location.search);
        const lang = urlParams.get('lang') || 'en';
        
        firebase.database().ref('products').on('value', (snapshot) => {
            const container = document.getElementById('g');
            container.innerHTML = '';
            snapshot.forEach((child) => {
                const p = child.val();
                const isFree = p.price === 0;
                const pTxt = isFree ? (lang === 'ar' ? 'مجاناً' : 'FREE') : '$' + p.price;
                const bTxt = isFree ? (lang === 'ar' ? 'تحميل 📥' : 'Download 📥') : (lang === 'ar' ? 'شراء الآن 💳' : 'Buy Now 💳');
                const fClass = isFree ? 'free' : '';
                
                container.innerHTML += '<div class="card">' +
                    '<img src="' + (p.image_url || 'https://via.placeholder.com/150') + '" />' +
                    '<div class="title">' + p.name + '</div>' +
                    '<div class="price ' + fClass + '">' + pTxt + '</div>' +
                    '<button class="btn" onclick="window.open(\\'' + p.link + '\\', \\'_blank\\')">' + bTxt + '</button>' +
                '</div>';
            });
        });
    </script>
</body>
</html>
        `);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('M92 Infrastructure Online\n');
    }
}).listen(PORT);
