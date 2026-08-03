# Identity resolver

This is the first runnable slice of `id.greenways.ai`. It verifies self-signed
identity registration actions and returns content-rooted identity and handle
resolutions. Its in-memory store is a development adapter; production needs a
durable public-record store.

It does not accept private keys, recover identities, choose among colliding
handles, maintain a global chain, or assign a universal reputation score.

```sh
npm test
npm start
```
