const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8739068450:AAHIcEFECoLgWs6sfV9KCCsc-bxWs8hKqtA';
const LOOTLABS_API_KEY = 'f540d2476d6156d459268adbdd95ec456a403db7eb91a3e05e129b9f84a86396';
const FIREBASE_DB_URL = 'https://duce-basic-default-rtdb.firebaseio.com';

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
    const userId = ctx.from.id;
    const lootlabsLink = `https://loot-link.com/s?Q8x9t8az&puid=${userId}`;
    ctx.reply(`أهلاً بك يا غالي! 🌟\n\nللحصول على المفتاح الخاص بك، يرجى تخطي هذا الرابط أولاً:\n🔗 ${lootlabsLink}\n\nبعد تخطي الرابط بنجاح، اضغط على زر /getkey للحصول على مفتاحك مباشرة.`);
});

bot.command('getkey', async (ctx) => {
    const userId = ctx.from.id;

    try {
        // التحقق من LootLabs API مباشرة
        const lootlabsResponse = await axios.get(
            `https://api.lootlabs.gg/api/lootlabs/task_completed?subid=${userId}`,
            {
                headers: {
                    'Authorization': `Bearer ${LOOTLABS_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const completed = lootlabsResponse.data?.completed === true || 
                          lootlabsResponse.data?.task_completed === true ||
                          lootlabsResponse.data?.status === 'completed';

        if (completed) {
            // جلب المفاتيح من Firebase
            const keysResponse = await axios.get(`${FIREBASE_DB_URL}/keys.json`);
            const keysData = keysResponse.data;

            if (!keysData) {
                return ctx.reply("❌ لا توجد مفاتيح متوفرة حالياً. يرجى مراسلة الإدارة.");
            }

            let foundKeyId = null;
            let foundKeyValue = null;

            for (const keyId in keysData) {
                const k = keysData[keyId];
                if (!k.used && !k.banned && (!k.device_id || k.device_id === "") && !k.assignedTo) {
                    foundKeyId = keyId;
                    foundKeyValue = k.key;
                    break;
                }
            }

            if (!foundKeyValue) {
                return ctx.reply("❌ نفدت المفاتيح المتاحة حالياً! سنقوم بتجديدها قريباً.");
            }

            await axios.patch(`${FIREBASE_DB_URL}/keys/${foundKeyId}.json`, {
                used: true,
                assignedTo: userId,
                device_id: `telegram_${userId}`
            });

            ctx.reply(`🎉 تفضل، هذا هو المفتاح الخاص بك:\n\n${foundKeyValue}`);

        } else {
            ctx.reply("⚠️ لم تقم بتخطي الرابط بعد. يرجى الضغط على /start وتخطي الرابط أولاً.");
        }

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        
        // fallback: تحقق من Firebase
        try {
            const userCheck = await axios.get(`${FIREBASE_DB_URL}/users/${userId}.json`);
            const userData = userCheck.data;

            if (userData && userData.completedLootLabs === true) {
                const keysResponse = await axios.get(`${FIREBASE_DB_URL}/keys.json`);
                const keysData = keysResponse.data;

                let foundKeyId = null;
                let foundKeyValue = null;

                for (const keyId in keysData) {
                    const k = keysData[keyId];
                    if (!k.used && !k.banned && (!k.device_id || k.device_id === "") && !k.assignedTo) {
                        foundKeyId = keyId;
                        foundKeyValue = k.key;
                        break;
                    }
                }

                if (!foundKeyValue) {
                    return ctx.reply("❌ نفدت المفاتيح المتاحة حالياً!");
                }

                await axios.patch(`${FIREBASE_DB_URL}/keys/${foundKeyId}.json`, {
                    used: true,
                    assignedTo: userId,
                    device_id: `telegram_${userId}`
                });

                await axios.patch(`${FIREBASE_DB_URL}/users/${userId}.json`, {
                    completedLootLabs: false
                });

                ctx.reply(`🎉 تفضل، هذا هو المفتاح الخاص بك:\n\n${foundKeyValue}`);
            } else {
                ctx.reply("⚠️ لم تقم بتخطي الرابط بعد. يرجى الضغط على /start وتخطي الرابط أولاً.");
            }
        } catch (fbError) {
            console.error('Firebase error:', fbError.message);
            ctx.reply("حدث خطأ أثناء الاتصال. يرجى المحاولة لاحقاً.");
        }
    }
});

// استقبال Webhook من LootLabs
app.post('/lootlabs-webhook', async (req, res) => {
    try {
        const userId = req.body.subid || req.query.subid;
        console.log('Webhook received, userId:', userId);

        if (userId) {
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

// Keep alive
app.get('/', (req, res) => res.send('Bot is running!'));

bot.launch();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
