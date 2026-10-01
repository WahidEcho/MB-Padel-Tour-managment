# Move Score Mobile

The Move Score app (Expo SDK 57, iOS and Android) for spectators and referees.

Everything about the product — decisions, design, architecture, Phase 1 status and the
owner's to-do list — is in one file: **[PRODUCT_PLAN.md](./PRODUCT_PLAN.md)**.
Do not create separate planning files unless the product owner changes this rule.

```bash
npm install
npx expo run:ios            # development build on the simulator (needs Xcode)
npx expo run:android        # development build on an emulator or phone
npx tsc --noEmit            # type-check
```

The app reads `EXPO_PUBLIC_API_BASE_URL` (defaults per `APP_ENV` in `app.config.ts`).
Shared scoring and API types come from the web repo through `src/core/index.ts`.
