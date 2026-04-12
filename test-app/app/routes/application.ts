import Route from '@ember/routing/route';

export default class ApplicationRoute extends Route {
  async beforeModel() {
    // Multiple async ticks to give the router time to enter the loading substate
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => Promise.resolve().then(resolve));
    }
  }
}
