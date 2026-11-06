// Lookup queue: de-duplicates keys, runs at most `concurrency` jobs at once,
// each job gets a free slot index (used to pick a Highway worker tab).
// A job that throws an error with `.requeue = true` is put back at the front
// of the queue and the queue pauses (used for "Highway login needed").
(function (root) {
  class LookupQueue {
    constructor({ concurrency = 3, worker }) {
      this.concurrency = concurrency;
      this.worker = worker; // async (key, slotIndex) => result
      this.waiting = []; // keys, FIFO
      this.inflight = new Map(); // key -> { promise, resolve, reject }
      this.freeSlots = [];
      for (let i = 0; i < concurrency; i++) this.freeSlots.push(i);
      this.paused = false;
    }

    // Returns a promise for the key's result. Same key -> same promise.
    add(key) {
      const existing = this.inflight.get(key);
      if (existing) return existing.promise;
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.inflight.set(key, { promise, resolve, reject });
      this.waiting.push(key);
      this._pump();
      return promise;
    }

    has(key) {
      return this.inflight.has(key);
    }

    get size() {
      return this.inflight.size;
    }

    pause() {
      this.paused = true;
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this._pump();
    }

    _pump() {
      while (!this.paused && this.waiting.length && this.freeSlots.length) {
        const key = this.waiting.shift();
        const slot = this.freeSlots.shift();
        this._run(key, slot);
      }
    }

    async _run(key, slot) {
      const entry = this.inflight.get(key);
      try {
        const result = await this.worker(key, slot);
        this.inflight.delete(key);
        entry.resolve(result);
      } catch (err) {
        if (err && err.requeue) {
          this.waiting.unshift(key);
          this.paused = true;
        } else {
          this.inflight.delete(key);
          entry.reject(err);
        }
      } finally {
        this.freeSlots.push(slot);
        this.freeSlots.sort((a, b) => a - b);
        this._pump();
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { LookupQueue };
  else root.LookupQueue = LookupQueue;
})(typeof self !== 'undefined' ? self : this);
