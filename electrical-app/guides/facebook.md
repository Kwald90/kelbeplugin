# Get Facebook and Instagram lead ads into Fishtape

When someone fills in your Facebook or Instagram lead form, the lead appears on your **Leads** board within seconds, with their name, email, phone and answers. You can also enrol every new lead in a follow-up sequence, so they get an email or text right away.

About 45 minutes the first time. You need to be an owner or admin in Fishtape, on the Business plan, and an admin of your Facebook Page and of your Meta Business portfolio (Business Manager).

## What it costs

Nothing extra: Meta does not charge for getting your leads through its API, and Fishtape adds nothing. You pay Meta for the ads themselves. (Checked 2026-10-19.)

## 1. Create a Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and choose **Create app**.
2. Pick the use case for **managing business** or **Other**, then app type **Business**. Name it something like `TG Electrical leads` and connect it to your business portfolio.
3. In **App settings > Basic**, copy the **App secret** (press **Show**). In Fishtape, paste it into **Facebook app secret**.
4. Still in **Basic**, add a **Privacy policy URL** (your website's privacy page) and an app icon. Meta needs these before the app can go live.

## 2. Connect the webhook

1. In Fishtape, on the Facebook card, press **Generate** next to **Facebook webhook verify token**. Copy the token it fills in (it is shown once).
2. In your Meta app, add the **Webhooks** product. Pick **Page** from the list and choose **Subscribe to this object**.
3. Paste:
   - **Callback URL:** `{{webhook_url}}`
   - **Verify token:** the token from step 1
4. Before pressing **Verify and save** in Meta, press **Save** in Fishtape so it knows the token. Then verify in Meta.
5. In the list of Page fields, find **leadgen** and press **Subscribe**.

## 3. Get a Page access token that doesn't expire

The most reliable token comes from a system user in your business portfolio.

1. Open [business.facebook.com/settings](https://business.facebook.com/settings) > **Users > System users** and add one (role **Admin**), for example `Fishtape`.
2. Press **Assign assets**: give it your **Page** (full control) and your **app**.
3. Press **Generate new token**, pick your app, and tick: `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `ads_management`.
4. That gives a system user token. To turn it into a Page token, open the [Graph API Explorer](https://developers.facebook.com/tools/explorer), paste the token, and run `me/accounts`. Copy the `access_token` shown for your Page.
5. In Fishtape, paste it into **Facebook Page access token** and press **Save**.

## 4. Switch the app to Live

In your Meta app, set **App Mode** to **Live** (top of the dashboard). Meta only sends real leads to live apps. If Meta asks for business verification or app review for `leads_retrieval`, follow its steps; for your own Page and your own app this is usually quick.

## 5. Link the Page and test

1. In Fishtape, press **Test connection**. It fills in your **Page ID** and tells you whether the Page is sending leads to your app yet.
2. If it says the Page is not subscribed, press **Subscribe Page**.
3. Optional: pick a sequence in **Enrol new leads in** and press **Save**.
4. Open Meta's [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing), pick your Page and form, and press **Create lead**. Within seconds a lead with source **facebook** appears on your Leads board.

## Good to know

- Name, email and phone go into the lead's fields. Every other question and answer is copied into the lead's notes, and the first custom answer becomes the lead's title (for example "EV charger install").
- If a token stops working, the Facebook card shows an error. Meta retries each lead for up to 36 hours, so fix the token soon and nothing is lost.
- Each lead is imported once, even if Meta sends it twice.

> **Ask us to set this up.** Meta's setup is the longest of all the integrations. We can do it with you on a screen-share, test it with a real form and connect your follow-up sequence, for a flat fee quoted up front. Included with Enterprise. [Email us](mailto:setup@fishtapehq.com?subject=Please%20set%20up%20Facebook%20Lead%20Ads) or press **Ask us to set this up** on the card.
