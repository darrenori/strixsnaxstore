# Assets

## `paynow-static.png`

The committee's printed PayNow QR, the one on the poster. It pays UEN
`200604346E` (National University of Singapore) with the reference
"Strix Snack Store Copay", and the amount is left editable, so whoever scans it
types the sum themselves.

It is shown only when `PAYNOW_PROXY_VALUE` is unset, which is to say when the
app cannot mint a QR per order.

**You almost certainly want the dynamic path instead**, and it is what is
configured. `PAYNOW_PROXY_TYPE=uen` and `PAYNOW_PROXY_VALUE=200604346E` give
every order its own QR paying the same UEN, with the amount already filled in
and locked, and the order code carried as the reference. That is what stops the
"paid $1.20 instead of $12.00" problem the Google Form had, and it is what makes
a payment match an order without anybody reading a screenshot twice.

So this file is the fallback, not the main path. It is worth keeping current
anyway, because if the proxy is ever cleared the store falls back to whatever
sits here, and a stale QR pointing at the wrong account is a bad way to find
that out.

To go back to the single printed QR on purpose, clear `PAYNOW_PROXY_VALUE`.
Buyers then type the amount themselves and the checkout screen tells them the
exact figure and the order code to quote as the reference.
