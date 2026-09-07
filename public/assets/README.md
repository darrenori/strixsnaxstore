# Assets

## `paynow-static.svg` — placeholder

Shown only when `PAYNOW_PROXY_VALUE` is unset, i.e. when the app cannot mint a
QR per order.

**You almost certainly want the dynamic path instead.** Set `PAYNOW_PROXY_TYPE`
and `PAYNOW_PROXY_VALUE` in `.env` and every order gets its own QR with the
amount and the order code already filled in — which is what stops the
"paid $1.20 instead of $12.00" problem the Google Form had.

If you would rather keep the single printed QR from the poster:

1. Save that QR as `public/assets/paynow-static.png`.
2. Set `PAYNOW_STATIC_QR=/assets/paynow-static.png` in `.env`.
3. Leave `PAYNOW_PROXY_VALUE` blank.

Buyers then type the amount themselves, and the checkout screen tells them the
exact figure and the order code to use as the reference.
