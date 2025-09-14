# Використовуємо Node 20 (підтримується better-sqlite3@12.2.0)
FROM node:20

# Встановлюємо робочу директорію
WORKDIR /app

# Копіюємо package.json і package-lock.json (якщо є)
COPY package*.json ./

# Встановлюємо залежності
RUN npm install --omit=dev

# Копіюємо решту файлів проєкту
COPY . .

# Запускаємо твій бот (можна підставити будь-який скрипт із package.json)
CMD ["npm", "run", "bot"]