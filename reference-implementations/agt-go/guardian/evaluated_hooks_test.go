package guardian_test

import (
	"context"
	"slices"
	"testing"

	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/acs"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/guardian"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/internal/method"
	"github.com/GenAI-Security-Project/agent-control-standard/reference-implementations/agt-go/internal/observedagent"
)

// A deployment that evaluates only some hooks offers only those, and a step
// of any other is refused as not negotiated rather than decided.
func TestEvaluatedHooksLimitTheServerHello(t *testing.T) {
	h := newHarness(t, func(c *guardian.Config) {
		c.EvaluatedHooks = []string{acs.StepUserMessage, acs.StepToolCallRequest}
	})
	c := h.client(observedagent.NewUUID())
	o, err := c.Handshake(context.Background(), observedagent.DefaultHello(method.Hooks()...))
	if err != nil {
		t.Fatal(err)
	}
	if o.Hello == nil {
		t.Fatalf("handshake refused: %s", o.Raw)
	}
	if want := []string{acs.StepToolCallRequest, acs.StepUserMessage}; !slices.Equal(sorted(o.Hello.MethodsEvaluated), want) {
		t.Fatalf("methods_evaluated %v, want %v", o.Hello.MethodsEvaluated, want)
	}
	h.decision(c, acs.StepToolCallRequest, hookPayloads[acs.StepToolCallRequest])
	h.refusal(c, observedagent.Request{Method: acs.StepTurnStart, Payload: hookPayloads[acs.StepTurnStart]}, acs.CapabilityNotNegotiated)
	if h.engine.callCount() != 1 {
		t.Fatalf("the engine was called %d times, want once", h.engine.callCount())
	}
}

func TestEvaluatedHooksRefusesWhatItCannotOffer(t *testing.T) {
	signer, err := guardian.NewHMACSigner(guardian.HMACKey{ID: "k1", Secret: ikm})
	if err != nil {
		t.Fatal(err)
	}
	for name, hooks := range map[string][]string{
		"no_hook":          {},
		"not_a_hook":       {"steps/notAHook"},
		"a_hook_twice":     {acs.StepTurnEnd, acs.StepTurnEnd},
		"a_wrapped_method": {"protocols/MCP/tools/call"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := guardian.New(guardian.Config{Engine: &testEngine{}, Signer: signer, EvaluatedHooks: hooks})
			if err == nil {
				t.Fatal("guardian.New accepted it")
			}
		})
	}
}

// metadata.turn_id is accepted on every native hook.
func TestTurnIDIsAcceptedOnEveryHook(t *testing.T) {
	h := newHarness(t)
	c := h.session()
	for _, hook := range method.Hooks() {
		o := h.send(c, observedagent.Request{Method: hook, Payload: hookPayloads[hook], TurnID: "turn-1"})
		if o.Result == nil {
			t.Fatalf("%s with metadata.turn_id: no decision: %s", hook, o.Raw)
		}
	}
}

func sorted(s []string) []string {
	s = slices.Clone(s)
	slices.Sort(s)
	return s
}
