const vaultRecord = 'moodle-credentials';

function vaultKey(create = true) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('agenda-campus-vault', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onerror = () => reject(request.error);
    request.onsuccess = async () => {
      const database = request.result;
      try {
        const lookup = database.transaction('keys').objectStore('keys').get('moodle');
        const existing = await new Promise((done, fail) => {
          lookup.onsuccess = () => done(lookup.result);
          lookup.onerror = () => fail(lookup.error);
        });
        if (existing || !create) { resolve(existing); return; }
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const transaction = database.transaction('keys', 'readwrite');
        transaction.objectStore('keys').put(key, 'moodle');
        await new Promise((done, fail) => {
          transaction.oncomplete = done;
          transaction.onabort = () => fail(transaction.error);
        });
        resolve(key);
      } catch (error) {
        reject(error);
      } finally {
        database.close();
      }
    };
  });
}

async function saveCredentials(username, password) {
  const key = await vaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify({ username, password }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  await chrome.storage.local.set({
    [vaultRecord]: { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) },
    'moodle-autologin-tried': false
  });
}

async function loadCredentials() {
  const stored = (await chrome.storage.local.get(vaultRecord))[vaultRecord];
  if (!stored) return null;
  const key = await vaultKey(false);
  if (!key) throw new Error('Falta la clave local de las credenciales.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(stored.iv) }, key, new Uint8Array(stored.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
