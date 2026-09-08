---
name: django_query_optimization
description: Best practices for resolving N+1 query issues in Django and DRF. Trigger when user asks to optimize a Django view, queryset, or serializer; user mentions N+1 queries, slow queries, or performance issues in Django/DRF; user asks to add `select_related`, `prefetch_related`, or `annotate`; user asks to optimize a list endpoint or API; code contains a serializer with `SerializerMethodField` that hits the DB; user says "optimize", "speed up", or "fix queries" in a Django context.
DO NOT TRIGGER when: the task is unrelated to Django database queries (e.g., frontend work, migrations, authentication).
version: 1.0.0
---

# Django & DRF Query Optimization

This skill provides a set of patterns and best practices for identifying and resolving N+1 query issues, particularly when working with Django Rest Framework (DRF) list views.


## 1. Bulk Fetching Patterns

### select_related
Use `select_related` for "forward" relationships (ForeignKey, OneToOne) where the record count is 1:1 or N:1. This uses an SQL `JOIN`.

```python
# In ViewSet
def get_queryset(self):
    return Book.objects.all().select_related('author', 'publisher')
```

### prefetch_related
Use `prefetch_related` for "reverse" relationships (ForeignKey back-refs) or "many-to-many" relationships. This executes separate queries and joins them in Python.

```python
# In ViewSet
def get_queryset(self):
    return Author.objects.all().prefetch_related('books')
```

### Prefetch Objects
Use `Prefetch` objects to further optimize pre-fetched data (e.g., filtering or ordering the related queryset).

```python
from django.db.models import Prefetch

def get_queryset(self):
    active_books = Book.objects.filter(is_published=True)
    return Author.objects.prefetch_related(
        Prefetch('books', queryset=active_books, to_attr='published_books')
    )
```

## 2. Advanced Resolution Patterns

### Bulk Lookup Map Pattern
When a simple `prefetch_related` isn't enough (e.g., complex logic or external utility calls), fetch the data for all IDs once and use a dictionary for O(1) lookups in the loop.

```python
# In View or Utility
class PersonDataUtil:
    def __init__(self, person_ids):
        # Fetch everything in 1-2 queries
        self.data_map = {
            d['person_id']: d['value'] 
            for d in RelatedModel.objects.filter(person_id__in=person_ids).values('person_id', 'value')
        }

    def get_value(self, person_id):
        return self.data_map.get(person_id, 0)
```

### Passing Pre-fetched Data via Context
Standardize data access by passing pre-fetched maps or utility instances through the serializer `context`. This avoids re-fetching in `SerializerMethodField`.

### Hierarchical Subtree Optimization (Treebeard/MPTT)
When fetching descendants for a list of nodes, avoid recursive database calls. Use the `path` attribute (for Treebeard MP_Node) or `lft/rght` (for MPTT) to fetch all descendants in a single query.

```python
# Bulks fetch descendants for a set of teams
root_paths = [team.path for team in leading_teams]
descendants = Team.objects.filter(
    reduce(operator.or_, [Q(path__startswith=p) for p in root_paths])
)
```

### Instance-level Memoization in Serializers
If multiple `SerializerMethodFields` depend on the same complex calculation or related queryset, cache the result on the serializer instance to avoid redundant database hits or CPU work.

```python
class TeamSerializer(serializers.ModelSerializer):
    joined_count = serializers.SerializerMethodField()
    left_count = serializers.SerializerMethodField()

    @property
    def _members(self):
        if not hasattr(self, "_cached_members"):
            # Fetch all once
            self._cached_members = list(self.instance.members.all())
        return self._cached_members

    def get_joined_count(self, obj):
        return len([m for m in self._members if m.start_date <= today])
```

## 3. Serializer Best Practices

### Prefer SerializerMethodField over Model Properties
If a model property (e.g., `@property def is_active(self):`) performs a database query (like `.exists()` or `.filter()`), it will trigger an N+1 issue in a list view.

**Solution:**
1.  Add the necessary `prefetch_related` in the `get_queryset` method of the ViewSet.
2.  Define a `SerializerMethodField` in the serializer.
3.  Access the pre-fetched data using `.all()` (which hits the cache) instead of `.filter()` (which hits the DB).

```python
# Model
class PersonTeam(models.Model):
    @property
    def is_lead(self):
        # BAD: This hits DB for every item
        return self.team_roles.filter(role='LEAD').exists()

# Serializer Fix
class PersonTeamSerializer(serializers.ModelSerializer):
    is_lead = serializers.SerializerMethodField()

    def get_is_lead(self, instance):
        # GOOD: This uses the prefetched cache if prefetch_related('team_roles') was used
        roles = instance.team_roles.all()
        return any(r.role == 'LEAD' for r in roles)
```

## 4. Contextual Data Passing

Avoid fetching global or semi-static data (like exchange rates) per item. Fetch it once in the view and pass it via `serializer.context`.

```python
# ViewSet
def get_serializer_context(self):
    context = super().get_serializer_context()
    context['dollar_rates'] = get_dollar_rates_by_month()
    return context

# Serializer
def get_recurring_bonuses(self, instance):
    rates = self.context.get('dollar_rates')
    # Use rates for calculations...
```

## 5. Common Pitfalls

### The `.filter()` on Related Managers Trap
**NEVER** call `.filter()` or `.exclude()` on a related manager inside a loop (like a serializer) if you expect to use pre-fetched data. These methods **always** hit the database.

**Bad:**
```python
def get_active_items(self, obj):
    # Hits the DB for every object, even if 'items' were pre-fetched
    return obj.items.filter(is_active=True).all()
```

**Good:**
```python
# 1. In ViewSet: use Prefetch
queryset.prefetch_related(Prefetch('items', queryset=Item.objects.filter(is_active=True)))

# 2. In Serializer: use .all()
def get_active_items(self, obj):
    # Uses pre-fetched cache
    return obj.items.all()
```

### Aggregates in Loops
Calling `.aggregate()` (e.g., `Sum`, `Avg`) inside a loop is an N+1 issue.

**Solution:** 
- Use `annotate()` on the main queryset to perform the calculation in the same SQL query.
- If too complex for `annotate()`, use the **Bulk Lookup Map Pattern** with a manual aggregate query (`values('group_field').annotate(total=Sum('value'))`).

## 6. Optimization Checklist

- [ ] **Hierarchical Data?** Use `path__startswith` for bulk fetching.
- [ ] **Redundant fields?** Use instance-level memoization in the serializer.
- [ ] **Exclusions?** Fetch exclusion IDs into a `set` once before the loop.
- [ ] **Nested Helper hitting DB?** Pre-fetch the exact data the helper needs (e.g., `employment_history`) to satisfy its internal lookups from cache.