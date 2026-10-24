<script setup>
defineProps({
  role: { type: Object, required: true }
})
</script>

<template>
  <div class="role-card">
    <div class="role-head">
      <span class="role-title">
        <span class="role-icon">{{ role.icon }}</span>
        <span>{{ role.title }}</span>
      </span>
      <a-tag :color="role.tagColor">{{ role.tag }}</a-tag>
    </div>

    <p class="role-summary">{{ role.summary }}</p>

    <span class="role-block-title">核心职责</span>
    <ul class="role-list">
      <li v-for="(p, i) in role.points" :key="i">{{ p }}</li>
    </ul>

    <span class="role-block-title">适用场景</span>
    <p class="role-scenario">{{ role.scenario }}</p>

    <a-alert
      :type="role.warnType"
      show-icon
      :message="role.warn"
      style="margin-top: 16px"
    />

    <div class="role-foot">
      <a-button type="primary" size="large" block :href="role.href">
        {{ role.buttonText }}
      </a-button>
      <span class="role-path">{{ role.href }}</span>
    </div>
  </div>
</template>

<style scoped>
.role-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  padding: 24px;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03);
}

.role-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.role-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
}

.role-icon {
  font-size: 18px;
  line-height: 1;
}

.role-summary {
  color: rgba(0, 0, 0, 0.88);
  margin-top: 0;
  line-height: 1.6;
}

.role-block-title {
  display: block;
  margin-top: 16px;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.88);
}

.role-list {
  margin: 8px 0 0;
  padding-left: 20px;
  color: rgba(0, 0, 0, 0.65);
  line-height: 1.8;
}

.role-list li {
  margin-bottom: 4px;
}

.role-scenario {
  color: rgba(0, 0, 0, 0.45);
  margin: 4px 0 0;
  line-height: 1.5;
}

.role-foot {
  margin-top: auto;
  padding-top: 20px;
}

.role-path {
  display: block;
  margin-top: 8px;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}
</style>
