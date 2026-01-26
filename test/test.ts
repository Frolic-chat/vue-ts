import Vue from "vue";
import { Component, Prop, Watch, Hook } from '../index';

@Component({})
export default class My extends Vue {
  @Prop({ default: 'foo' })
  foo!: string;

  data: number = 0;

  @Watch('foo')
  onFoo() {
    console.log('Foo changed.');
  }

  get bar() { return this.foo + 'bar'; }

  get baz() { return this.foo + 'baz'; }
  set baz(_value: any) {
    // Do nothing
  }

  @Hook('created')
  created_method_name() { console.log('created'); }
}


// Expected out:

// const My = Vue.extend({
//   name: 'My',
//   data() { return { } },
//   props: { foo: { default: 'foo' } },
//   methods: { created_method_name() { console.log('created'); }, onFoo() { console.log('Foo changed.'); } },
//   computed: { bar: { get() { return this.foo + 'bar'; } }, baz: { get() { return this.foo + 'baz' }, set(value: any) { } } },
//   watch: { foo: [ { handler: 'onFoo' } ] },
//   created() { this.onFoo.apply(this, arguments); }
// });
// export default My;
