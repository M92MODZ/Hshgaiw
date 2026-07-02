const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');

// إعداد السيرفر والبوت
const app = express();
app.use(express.json());

const BOT_TOKEN = '8739068450:AAHIcEFECoLgWs6sfV9KCCsc-bxWs8hKqtA';
const LOOTLABS_API_KEY = 'f540d2476d6156d459268adbdd95ec456a403db7eb91a3e05e129b9f84a86396';
const FIREBASE_DB_URL = 'https://duce-basic-default-rtdb.firebaseio.com';

const bot = new Telegraf(BOT_TOKEN);

// --- منطق البوت ---

bot.start((ctx) => {
    const userId = ctx.from.id;
    // استبدل رابط اللينك الخاص بك من LootLabs
    // نرسل الـ userId كـ subid لكي نتعرف عليه لاحقاً
    const lootlabsLink = `https://loot-link.com/s?Q8x9t8az&subid=${userId}`; 

    ctx.reply(`أهلاً بك يا غالي! 🌟\n\nللحصول على المفتاح الخاص بك، يرجى تخطي هذا الرابط أولاً:\n🔗 ${lootlabsLink}\n\nبعد تخطي الرابط بنجاح، اضغط على زر /getkey للحصول على مفتاحك مباشرة.`);
});

bot.command('getkey', async (ctx) => {
    const userId = ctx.from.id;

    try {
        // 1. التحقق من حالة المستخدم في Firebase Realtime Database
        const userCheck = await axios.get(`${FIREBASE_DB_URL}/users/${userId}.json`);
        const userData = userCheck.data;

        if (userData && userData.completedLootLabs === true) {
            
            // 2. جلب المفاتيح المتوفرة من Firebase
            const keysResponse = await axios.get(`${FIREBASE_DB_URL}/keys.json`);
            const keysData = keysResponse.data;

            if (!keysData) {
                return ctx.reply("❌ نعتذر منك، لا توجد مفاتيح متوفرة في قاعدة البيانات حالياً. يرجى مراسلة الإدارة.");
            }

            // البحث عن أول مفتاح غير مستخدم (used: false)
            let foundKeyId = null;
            let foundKeyValue = null;

            for (const keyId in keysData) {
                if (keysData[keyId].used === false) {
                    foundKeyId = keyId;
                    foundKeyValue = keysData[keyId].keyValue;
                    break;
                }
            }

            if (!foundKeyValue) {
                return ctx.reply("❌ نفدت المفاتيح المتاحة حالياً! سنقوم بتجديدها قريباً.");
            }

            // 3. تحديث حالة المفتاح في Firebase ليصبح مستخدماً ومربوطاً بالمستخدم
            await axios.patch(`${FIREBASE_DB_URL}/keys/${foundKeyId}.json`, {
                used: true,
                assignedTo: userId
            });

            // 4. إعادة تعيين حالة المستخدم في قاعدة البيانات حتى لا يسحب مفتاحاً آخر بنفس الرابط
            await axios.patch(`${FIREBASE_DB_URL}/users/${userId}.json`, {
                completedLootLabs: false
            });

            // إرسال المفتاح للمستخدم
            ctx.reply(`🎉 تفضل، هذا هو المفتاح الخاص بك:\n\n\`${foundKeyValue}\``, { parse_mode: 'MarkdownV2' });

        } else {
            ctx.reply("⚠️ لم تقم بتخطي الرابط بعد، أو أنك استهلكت رابطك السابق. يرجى الضغط على /start وتخطي الرابط أولاً.");
        }
    } catch (error) {
        console.error(error);
        ctx.reply("حدث خطأ أثناء الاتصال بقاعدة البيانات. يرجى المحاولة لاحقاً.");
    }
});

// --- استقبال تواصل LootLabs (Webhook) ---
app.post('/lootlabs-webhook', async (req, res) => {
    try {
        const userId = req.body.subid || req.query.subid;

        if (userId) {
            // تحديث حالة المستخدم في Firebase Realtime Database
            await axios.patch(`${FIREBASE_DB_URL}/users/${userId}.json`, {
                completedLootLabs: true,
                timestamp: Date.now()
            });

            return res.status(200).send('Success');
        }
        res.status(400).send('Missing subid');
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Error');
    }
});

// تشغيل البوت والسيرفر
bot.launch();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running 24/7 on port ${PORT}`));
