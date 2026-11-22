#include <hermes/hermes.h>
#include <jsi/instrumentation.h>
#include <jsi/jsi.h>
#include <TargetConditionals.h>

#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace jsi = facebook::jsi;

namespace {
class TracingHostObject final : public jsi::HostObject {
 public:
  int effects = 0;

  jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
    ++effects;
    return 1;
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &runtime) override {
    ++effects;
    std::vector<jsi::PropNameID> names;
    names.push_back(jsi::PropNameID::forAscii(runtime, "value"));
    return names;
  }
};

void setFunction(jsi::Runtime &runtime, jsi::Object &object, const char *name,
                 unsigned count, jsi::HostFunctionType function) {
  object.setProperty(runtime, name, jsi::Function::createFromHostFunction(
                                        runtime, jsi::PropNameID::forAscii(runtime, name), count, std::move(function)));
}

jsi::Value probe(jsi::Runtime &runtime, const jsi::Value &, const jsi::Value *args, size_t) {
  const auto method = args[0].asString(runtime).utf8(runtime);
  const auto object = args[1].asObject(runtime);
  if (method == "property") return object.getProperty(runtime, "value");
  if (method == "prototype") return object.getPrototype(runtime).isObject();
  if (method == "names") return static_cast<double>(object.getPropertyNames(runtime).size(runtime));
  if (method == "native-state") return object.hasNativeState(runtime);
  if (method == "unique-id") {
    auto *api = jsi::castInterface<facebook::hermes::IHermes>(&runtime);
    if (!api) throw std::runtime_error("Hermes interface unavailable");
    return jsi::String::createFromUtf8(runtime, std::to_string(api->getUniqueID(object)));
  }
  if (method == "set-native-state") {
    object.setNativeState(runtime, std::make_shared<jsi::NativeState>());
    return true;
  }
  throw jsi::JSError(runtime, "Unknown probe");
}
} // namespace

int main(int argc, char **argv) {
  constexpr std::string_view internalMode = "internal-test-methods";
  if (argc != 3 || (argv[2] != internalMode && std::string_view(argv[2]) != "reflection")) {
    std::cerr << "Usage: hermes-inspection FIXTURE.hbc reflection|internal-test-methods\n";
    return 2;
  }

  try {
    std::ifstream input(argv[1], std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open fixture bytecode");
    const std::string code(std::istreambuf_iterator<char>{input}, {});
    const bool internal = argv[2] == internalMode;
    const auto config = hermes::vm::RuntimeConfig::Builder().withEnableHermesInternalTestMethods(internal).build();
    auto runtime = facebook::hermes::makeHermesRuntime(config);

    auto fixtures = runtime->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(code), "strict-inspection.js").asObject(*runtime);
    auto hermesInternal = runtime->global().getPropertyAsObject(*runtime, "HermesInternal");
    auto isProxy = hermesInternal.getProperty(*runtime, "isProxy");
    const bool predicateAvailable = isProxy.isObject() && isProxy.asObject(*runtime).isFunction(*runtime);
    if (predicateAvailable != internal) throw std::runtime_error("HermesInternal.isProxy availability differs from the selected runtime configuration");

    jsi::Object native(*runtime);
    const auto tracing = std::make_shared<TracingHostObject>();
    native.setProperty(*runtime, "hostObject", jsi::Object::createFromHostObject(*runtime, tracing));
    setFunction(*runtime, native, "hostEffects", 0, [tracing](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) { return tracing->effects; });
    setFunction(*runtime, native, "isHostObject", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t) { return args[0].asObject(rt).isHostObject(rt); });
    setFunction(*runtime, native, "probe", 2, probe);

    auto classifier = fixtures.getPropertyAsFunction(*runtime, "descriptorClassifier").call(*runtime, isProxy, native.getProperty(*runtime, "isHostObject"));
    auto result = fixtures.getPropertyAsFunction(*runtime, "run").call(*runtime, classifier, native).asObject(*runtime);
    result.setProperty(*runtime, "host", TARGET_OS_SIMULATOR ? "iOS Simulator" : "macOS");
    result.setProperty(*runtime, "engine", runtime->description());
    result.setProperty(*runtime, "mode", std::string(argv[2]));
    result.setProperty(*runtime, "internalProxyPredicate", predicateAvailable);
    result.setProperty(*runtime, "runtimeProperties", hermesInternal.getPropertyAsFunction(*runtime, "getRuntimeProperties").call(*runtime));
    result.setProperty(*runtime, "nativeObservations", fixtures.getPropertyAsFunction(*runtime, "observeNativeMethods").call(*runtime, native.getProperty(*runtime, "probe")));
    result.setProperty(*runtime, "brandObservations", fixtures.getPropertyAsFunction(*runtime, "observeHermesBrands").call(*runtime, native));
    auto &instrumentation = runtime->instrumentation();
    result.setProperty(*runtime, "heapCounters", static_cast<double>(instrumentation.getHeapInfo(false).size()));
    try {
      std::ostringstream snapshot;
      instrumentation.createSnapshotToStream(snapshot);
      result.setProperty(*runtime, "heapSnapshot", "available");
    } catch (const std::logic_error &error) {
      result.setProperty(*runtime, "heapSnapshot", std::string(error.what()));
    }

    auto json = runtime->global().getPropertyAsObject(*runtime, "JSON");
    const auto output = json.getPropertyAsFunction(*runtime, "stringify").call(*runtime, result, jsi::Value::null(), 2).asString(*runtime).utf8(*runtime);
    std::cout << output << '\n';
    return result.getPropertyAsObject(*runtime, "failures").asArray(*runtime).size(*runtime) == 0 ? 0 : 1;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 2;
  }
}
