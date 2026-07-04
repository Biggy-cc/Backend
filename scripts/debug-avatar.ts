import "dotenv/config";
import { getUser } from "../src/db/users.js";
import {
  fetchImageBytes,
  fetchTelegramPhotoUrl,
  resolveTelegramAvatarBytes,
  telegramUserpicSources,
} from "../src/telegram/profile.js";

const id = Number(process.argv[2] ?? "5309840190");

const user = await getUser(id);
console.log("user:", user);

const sources = telegramUserpicSources({
  photoUrl: user?.photo_url,
  username: user?.username,
});
console.log("sources:", sources);

for (const url of sources) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://telegram.org/",
      },
    });
    console.log("HEAD", url, "->", res.status, res.headers.get("content-type"));
  } catch (err) {
    console.log("HEAD", url, "-> ERROR", err);
  }
}

const botUrl = await fetchTelegramPhotoUrl(id);
console.log("botUrl:", botUrl);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (token) {
  const photosRes = await fetch(
    `https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${id}&limit=1`
  );
  console.log("getUserProfilePhotos:", await photosRes.text());

  const chatRes = await fetch(
    `https://api.telegram.org/bot${token}/getChat?chat_id=${id}`
  );
  console.log("getChat:", await chatRes.text());
}

const bytes = await resolveTelegramAvatarBytes({
  telegramId: id,
  photoUrl: user?.photo_url,
  username: user?.username,
});
console.log("resolved bytes:", bytes?.length ?? "null");
